//! HTTP surface for the local UI.
//!
//! Every mutating endpoint answers with the *whole* application state
//! (tasks + edges + recomputed schedule). The dataset is small and a
//! single client is always looking at all of it, so returning the full
//! state removes a class of drift bugs — and with peers merging changes
//! in the background, a partial response would be stale the moment it
//! was built anyway.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use yaiba_core::{Dep, Error, NewTask, NodeId, Schedule, Store, Task, TaskId, TaskPatch, schedule};

/// One project the server has open: its database, its change signal, and
/// its replication.
///
/// Every open project replicates, not just the one being looked at — that
/// is the point of holding them all. Switching is then only a change of
/// view, with nothing to catch up on.
pub struct OpenProject {
    pub name: String,
    pub db: PathBuf,
    pub store: Arc<Mutex<Store>>,
    /// Bumped after every local write so the sync layer knows to push.
    ///
    /// `notify_one` rather than `notify_waiters`: the sync task is not
    /// parked while it is mid-round, and `notify_waiters` discards a
    /// notification that lands in that window. `notify_one` stores a
    /// permit, so the change is picked up on the next loop instead of
    /// waiting out the idle timer.
    pub notify: Arc<tokio::sync::Notify>,
    /// `None` when started with `--no-sync`.
    pub sync: Option<Arc<yaiba_sync::SyncNode>>,
}

impl OpenProject {
    pub fn new(name: impl Into<String>, db: PathBuf, store: Store) -> Self {
        Self {
            name: name.into(),
            db,
            store: Arc::new(Mutex::new(store)),
            notify: Arc::new(tokio::sync::Notify::new()),
            sync: None,
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    /// Fixed after construction, so an index into it stays valid.
    projects: Arc<Vec<OpenProject>>,
    /// Index of the project being looked at. An index rather than a name
    /// so that reading it — which every handler does — is a load rather
    /// than a lock or a map lookup.
    active: Arc<AtomicUsize>,
}

impl AppState {
    /// A server holding one unnamed project. Used by the smoke test and
    /// anything else that just wants a store behind the HTTP surface.
    pub fn new(store: Store) -> Self {
        Self::with_projects(vec![OpenProject::new(
            projects_default_name(),
            PathBuf::new(),
            store,
        )])
    }

    /// # Panics
    /// If `projects` is empty. A server with nothing open has no state to
    /// serve and no meaningful answer for any endpoint, so this is a
    /// construction bug rather than a runtime condition.
    pub fn with_projects(projects: Vec<OpenProject>) -> Self {
        assert!(
            !projects.is_empty(),
            "a server needs at least one open project"
        );
        Self {
            projects: Arc::new(projects),
            active: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Point the server at a different open project. `false` if no project
    /// goes by that name.
    pub fn switch(&self, name: &str) -> bool {
        match self.projects.iter().position(|p| p.name == name) {
            Some(index) => {
                self.active.store(index, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub fn active(&self) -> &OpenProject {
        // The index only ever comes from `position` on this same vector,
        // which is fixed at construction, so it cannot be out of range.
        &self.projects[self.active.load(Ordering::SeqCst)]
    }

    pub fn projects(&self) -> &[OpenProject] {
        &self.projects
    }

    pub fn store(&self) -> &Arc<Mutex<Store>> {
        &self.active().store
    }
}

fn projects_default_name() -> String {
    "default".to_string()
}

/// Everything the client needs to render, in one payload.
#[derive(Serialize)]
pub struct StateResponse {
    tasks: Vec<Task>,
    deps: Vec<Dep>,
    schedule: Schedule,
    /// The date everything here is computed against — `asof` when one
    /// was given, otherwise today.
    today: NaiveDate,
    /// True when `today` is not the actual current date, so the UI can
    /// say so instead of quietly showing numbers that are not current.
    as_of: bool,
    /// This replica's id — shown in the UI so you can tell whose peer
    /// list you are looking at.
    node_id: NodeId,
}

#[derive(Deserialize)]
pub struct StateQuery {
    /// Report the plan as it stood on this date. Progress and status
    /// come from the recorded history; fields that keep no history
    /// (titles, dates, the breakdown) are shown as they are now.
    #[serde(default)]
    asof: Option<NaiveDate>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/state", get(get_state))
        .route("/api/tasks", post(create_task))
        // Registered before the `{id}` route so the literal segment is
        // matched first rather than failing UUID parsing.
        .route("/api/tasks/reorder", post(reorder))
        .route(
            "/api/tasks/{id}",
            axum::routing::patch(patch_task)
                .put(put_task)
                .delete(delete_task),
        )
        .route("/api/deps", post(add_dep))
        .route("/api/deps/{from}/{to}", axum::routing::delete(remove_dep))
        .route("/api/peers", get(get_peers).post(join_peer))
        .route("/api/projects", get(get_projects).post(switch_project))
        .with_state(state)
}

#[derive(Serialize)]
pub struct ProjectSummary {
    name: String,
    db: String,
    /// Hand this to someone to bring them into *this* project. `None`
    /// under `--no-sync`.
    ticket: Option<String>,
    peers: usize,
}

#[derive(Serialize)]
pub struct ProjectsResponse {
    projects: Vec<ProjectSummary>,
    active: String,
}

fn projects_response(state: &AppState) -> ProjectsResponse {
    ProjectsResponse {
        active: state.active().name.clone(),
        projects: state
            .projects()
            .iter()
            .map(|p| ProjectSummary {
                name: p.name.clone(),
                db: p.db.display().to_string(),
                ticket: p.sync.as_ref().map(|s| s.ticket().to_string()),
                peers: p.sync.as_ref().map_or(0, |s| s.peer_ids().len()),
            })
            .collect(),
    }
}

async fn get_projects(State(state): State<AppState>) -> Json<ProjectsResponse> {
    Json(projects_response(&state))
}

#[derive(Deserialize)]
struct SwitchRequest {
    name: String,
}

/// Change which open project the UI is looking at.
///
/// Only a change of view: every project was already replicating, so there
/// is nothing to start up and nothing to wait for.
async fn switch_project(
    State(state): State<AppState>,
    Json(req): Json<SwitchRequest>,
) -> ApiResult<Json<ProjectsResponse>> {
    if !state.switch(&req.name) {
        return Err(ApiError::message(
            StatusCode::NOT_FOUND,
            format!("no open project named {:?}", req.name),
        ));
    }
    Ok(Json(projects_response(&state)))
}

#[derive(Serialize)]
pub struct PeersResponse {
    /// Hand this to someone to bring them into this dataset. `None`
    /// when the replica was started with `--no-sync`.
    ticket: Option<String>,
    peers: Vec<String>,
}

async fn get_peers(State(state): State<AppState>) -> Json<PeersResponse> {
    let Some(sync) = &state.active().sync else {
        return Json(PeersResponse {
            ticket: None,
            peers: Vec::new(),
        });
    };
    Json(PeersResponse {
        ticket: Some(sync.ticket().to_string()),
        peers: sync.peer_ids().iter().map(|id| id.to_string()).collect(),
    })
}

#[derive(Deserialize)]
struct JoinRequest {
    ticket: String,
}

/// Adopt someone else's ticket, then sync immediately so the join has a
/// visible effect rather than waiting for the next tick.
async fn join_peer(
    State(state): State<AppState>,
    Json(req): Json<JoinRequest>,
) -> std::result::Result<Json<PeersResponse>, ApiError> {
    let Some(sync) = state.active().sync.clone() else {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            "this replica was started with --no-sync",
        ));
    };
    let ticket = req
        .ticket
        .parse()
        .map_err(|e: anyhow::Error| ApiError::message(StatusCode::BAD_REQUEST, e.to_string()))?;
    sync.join(&ticket)
        .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, e.to_string()))?;
    sync.sync_all().await;

    Ok(Json(PeersResponse {
        ticket: Some(sync.ticket().to_string()),
        peers: sync.peer_ids().iter().map(|id| id.to_string()).collect(),
    }))
}

/// Read the store and fold in a freshly computed schedule.
fn respond(store: &Store) -> ApiResult<Json<StateResponse>> {
    respond_at(store, None)
}

/// As [`respond`], but reporting the plan as of a chosen date.
fn respond_at(store: &Store, asof: Option<NaiveDate>) -> ApiResult<Json<StateResponse>> {
    let today = asof.unwrap_or_else(|| Local::now().date_naive());
    let snapshot = match asof {
        Some(date) => store.snapshot_at(date)?,
        None => store.snapshot()?,
    };
    // Scheduling against the as-of date is what makes the whole view
    // consistent: bars, slack and the progress line all agree on which
    // day "now" is.
    let schedule = schedule(&snapshot.tasks, &snapshot.deps, today);
    Ok(Json(StateResponse {
        tasks: snapshot.tasks,
        deps: snapshot.deps,
        schedule,
        today,
        // "A date was supplied" is not the same as "this isn't now":
        // `:asof today` supplies one and is still the live view.
        as_of: today != Local::now().date_naive(),
        node_id: store.node_id(),
    }))
}

async fn get_state(
    State(state): State<AppState>,
    Query(query): Query<StateQuery>,
) -> ApiResult<Json<StateResponse>> {
    let store = lock(&state);
    respond_at(&store, query.asof)
}

async fn create_task(
    State(state): State<AppState>,
    Json(new): Json<NewTask>,
) -> ApiResult<Json<StateResponse>> {
    let response = {
        let mut store = lock(&state);
        store.create_task(new)?;
        respond(&store)
    };
    state.active().notify.notify_one();
    response
}

async fn patch_task(
    State(state): State<AppState>,
    Path(id): Path<TaskId>,
    Json(patch): Json<TaskPatch>,
) -> ApiResult<Json<StateResponse>> {
    let response = {
        let mut store = lock(&state);
        store.patch_task(id, patch)?;
        respond(&store)
    };
    state.active().notify.notify_one();
    response
}

/// Write a task verbatim, clearing any tombstone.
///
/// This is the undo path for a delete: rather than removing rows (which
/// a peer would re-add on the next sync) it writes newer values that win
/// the merge everywhere.
async fn put_task(
    State(state): State<AppState>,
    Path(id): Path<TaskId>,
    Json(mut task): Json<Task>,
) -> ApiResult<Json<StateResponse>> {
    // The path is authoritative; a mismatched body id would otherwise
    // silently write to a different task.
    task.id = id;
    let response = {
        let mut store = lock(&state);
        store.put_task(&task)?;
        respond(&store)
    };
    state.active().notify.notify_one();
    response
}

async fn delete_task(
    State(state): State<AppState>,
    Path(id): Path<TaskId>,
) -> ApiResult<Json<StateResponse>> {
    let response = {
        let mut store = lock(&state);
        store.delete_task(id)?;
        respond(&store)
    };
    state.active().notify.notify_one();
    response
}

#[derive(Deserialize)]
struct ReorderRequest {
    ids: Vec<TaskId>,
}

async fn reorder(
    State(state): State<AppState>,
    Json(req): Json<ReorderRequest>,
) -> ApiResult<Json<StateResponse>> {
    let response = {
        let mut store = lock(&state);
        store.reorder(&req.ids)?;
        respond(&store)
    };
    state.active().notify.notify_one();
    response
}

async fn add_dep(
    State(state): State<AppState>,
    Json(dep): Json<Dep>,
) -> ApiResult<Json<StateResponse>> {
    let response = {
        let mut store = lock(&state);
        store.add_dep(dep.from, dep.to)?;
        respond(&store)
    };
    state.active().notify.notify_one();
    response
}

async fn remove_dep(
    State(state): State<AppState>,
    Path((from, to)): Path<(TaskId, TaskId)>,
) -> ApiResult<Json<StateResponse>> {
    let response = {
        let mut store = lock(&state);
        store.remove_dep(from, to)?;
        respond(&store)
    };
    state.active().notify.notify_one();
    response
}

/// A poisoned mutex means an earlier handler panicked mid-transaction.
/// SQLite rolled that transaction back, so the data is still consistent
/// and carrying on beats taking the whole process down.
fn lock(state: &AppState) -> std::sync::MutexGuard<'_, Store> {
    state.store().lock().unwrap_or_else(|e| e.into_inner())
}

pub enum ApiError {
    Domain(Error),
    /// A failure that isn't a store error — a malformed ticket, say.
    Message(StatusCode, String),
}

type ApiResult<T> = std::result::Result<T, ApiError>;

impl ApiError {
    fn message(status: StatusCode, text: impl Into<String>) -> Self {
        Self::Message(status, text.into())
    }
}

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        Self::Domain(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, text) = match self {
            ApiError::Message(status, text) => (status, text),
            ApiError::Domain(e) => {
                let status = match &e {
                    Error::NotFound(_) => StatusCode::NOT_FOUND,
                    // A cycle, a self-edge, or nesting a task inside its
                    // own subtree is a legal request against an illegal
                    // state transition — that's what 409 is.
                    Error::Cycle { .. } | Error::SelfDep | Error::ParentCycle => {
                        StatusCode::CONFLICT
                    }
                    Error::Sqlite(_) | Error::Other(_) => StatusCode::INTERNAL_SERVER_ERROR,
                };
                (status, e.to_string())
            }
        };
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = %text, "request failed");
        }
        (status, Json(serde_json::json!({ "error": text }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str) -> OpenProject {
        OpenProject::new(
            name,
            PathBuf::from(format!("{name}.db")),
            Store::open_in_memory().unwrap(),
        )
    }

    #[test]
    fn the_first_project_is_the_one_being_looked_at() {
        // main puts the project that was asked for at index 0, so this is
        // what makes `yaiba open work` land on `work` rather than on
        // whichever project happened to sort first.
        let state = AppState::with_projects(vec![project("work"), project("default")]);
        assert_eq!(state.active().name, "work");
    }

    #[test]
    fn switching_changes_which_store_is_served() {
        let state = AppState::with_projects(vec![project("work"), project("default")]);
        let before = Arc::as_ptr(state.store());

        assert!(state.switch("default"));
        assert_eq!(state.active().name, "default");
        assert_ne!(
            Arc::as_ptr(state.store()),
            before,
            "the handlers must reach a different database after a switch"
        );

        assert!(state.switch("work"));
        assert_eq!(Arc::as_ptr(state.store()), before);
    }

    #[test]
    fn switching_to_a_project_that_is_not_open_leaves_the_active_one_alone() {
        let state = AppState::with_projects(vec![project("work"), project("default")]);
        assert!(!state.switch("nope"));
        assert_eq!(state.active().name, "work");
    }

    /// `AppState` is cloned per request by axum, and every clone has to
    /// see the same selection — otherwise a switch would apply to the one
    /// request that made it and nothing else.
    #[test]
    fn a_switch_is_visible_to_every_clone() {
        let state = AppState::with_projects(vec![project("work"), project("default")]);
        let clone = state.clone();
        assert!(clone.switch("default"));
        assert_eq!(state.active().name, "default");
    }

    #[test]
    fn a_single_project_server_still_works() {
        let state = AppState::new(Store::open_in_memory().unwrap());
        assert_eq!(state.projects().len(), 1);
        assert!(state.active().sync.is_none());
    }
}
