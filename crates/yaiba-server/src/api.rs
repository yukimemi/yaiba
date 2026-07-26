//! HTTP surface for the local UI.
//!
//! Every mutating endpoint answers with the *whole* application state
//! (tasks + edges + recomputed schedule). The dataset is small and a
//! single client is always looking at all of it, so returning the full
//! state removes a class of drift bugs — and with peers merging changes
//! in the background, a partial response would be stale the moment it
//! was built anyway.

use std::path::PathBuf;
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
    /// The open set, which now grows and shrinks while the server runs.
    ///
    /// Handles rather than values, and a name rather than an index for
    /// `active`: removing a project shifts every index after it, so an
    /// index would quietly come to mean a different project. A name keeps
    /// meaning the same thing or stops resolving, and the second is a
    /// state that can be handled.
    /// Lock order, where both are taken: `projects` then `active`, never
    /// the other way. Only `remove` holds one while taking the other, and
    /// it must, so that no request can see an active name that resolves to
    /// nothing. Everything else releases the first before taking the
    /// second.
    projects: Arc<Mutex<Vec<Arc<OpenProject>>>>,
    active: Arc<Mutex<String>>,
    /// How a project created at runtime gets its replication, so it comes
    /// up the same way one opened at startup did. `None` under
    /// `--no-sync`, which is the whole reason this is an `Option`.
    transport: Option<yaiba_sync::Transport>,
}

impl AppState {
    /// A server holding one unnamed project. Used by the smoke test and
    /// anything else that just wants a store behind the HTTP surface.
    pub fn new(store: Store) -> Self {
        Self::with_projects(
            vec![OpenProject::new(DEFAULT_PROJECT, PathBuf::new(), store)],
            None,
        )
    }

    /// # Panics
    /// If `projects` is empty. A server with nothing open has no state to
    /// serve and no meaningful answer for any endpoint, so this is a
    /// construction bug rather than a runtime condition.
    pub fn with_projects(
        projects: Vec<OpenProject>,
        transport: Option<yaiba_sync::Transport>,
    ) -> Self {
        assert!(
            !projects.is_empty(),
            "a server needs at least one open project"
        );
        Self {
            active: Arc::new(Mutex::new(projects[0].name.clone())),
            projects: Arc::new(Mutex::new(projects.into_iter().map(Arc::new).collect())),
            transport,
        }
    }

    pub fn transport(&self) -> Option<yaiba_sync::Transport> {
        self.transport
    }

    fn open(&self) -> std::sync::MutexGuard<'_, Vec<Arc<OpenProject>>> {
        self.projects.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn active_name(&self) -> std::sync::MutexGuard<'_, String> {
        self.active.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Point the server at a different open project. `false` if no project
    /// goes by that name.
    pub fn switch(&self, name: &str) -> bool {
        if !self.open().iter().any(|p| p.name == name) {
            return false;
        }
        *self.active_name() = name.to_string();
        true
    }

    /// The project being looked at.
    ///
    /// Returns a handle rather than a reference: the vector it lives in is
    /// behind a lock now, and holding that lock for as long as a caller
    /// wants the project would serialize every request against every
    /// other one.
    ///
    /// # Panics
    /// If the active name resolves to nothing, which would mean a project
    /// was removed without the active pointer being moved off it — a bug
    /// in `remove`, not a reachable state.
    pub fn active(&self) -> Arc<OpenProject> {
        let name = self.active_name().clone();
        self.find(&name)
            .unwrap_or_else(|| panic!("the active project {name:?} is not open"))
    }

    pub fn find(&self, name: &str) -> Option<Arc<OpenProject>> {
        self.open().iter().find(|p| p.name == name).cloned()
    }

    pub fn projects(&self) -> Vec<Arc<OpenProject>> {
        self.open().clone()
    }

    pub fn is_open(&self, name: &str) -> bool {
        self.open().iter().any(|p| p.name == name)
    }

    /// Take a newly created project into the open set and look at it.
    ///
    /// `false` if the name is already open, which the caller should have
    /// refused earlier — two projects under one name would make `switch`
    /// and `remove` ambiguous.
    pub fn insert(&self, project: OpenProject) -> bool {
        let mut open = self.open();
        if open.iter().any(|p| p.name == project.name) {
            return false;
        }
        let name = project.name.clone();
        open.push(Arc::new(project));
        drop(open);
        *self.active_name() = name;
        true
    }

    /// Close a project, moving off it first if it is the one being looked
    /// at. Returns the name now active, or `None` if nothing was removed.
    ///
    /// Refuses to remove the last one: the server would then have no state
    /// to serve and every endpoint would have nothing to answer with.
    pub fn remove(&self, name: &str) -> Option<String> {
        let mut open = self.open();
        if open.len() <= 1 {
            return None;
        }
        let at = open.iter().position(|p| p.name == name)?;
        open.remove(at);
        // Move off it *before* releasing the lock, so no request can
        // observe an active name that resolves to nothing.
        let mut active = self.active_name();
        if *active == name {
            // The one that took its place, or the last if it was last.
            *active = open[at.min(open.len() - 1)].name.clone();
        }
        Some(active.clone())
    }
}

/// What the single-project constructor calls its project.
pub const DEFAULT_PROJECT: &str = "default";

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
        .route("/api/projects/new", post(create_project))
        .route(
            "/api/projects/{name}",
            axum::routing::delete(forget_project),
        )
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

/// Start a project and open it, without restarting.
///
/// Goes through the same registry rules the CLI's `yaiba new` does — a
/// name already registered, a name whose slug lands on another project's
/// database, a database left behind by an earlier `forget` — because a
/// second way in must not be a way around them.
async fn create_project(
    State(state): State<AppState>,
    Json(req): Json<SwitchRequest>,
) -> ApiResult<Json<ProjectsResponse>> {
    let name = crate::projects::validate_name(&req.name)
        .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, e.to_string()))?
        .to_string();

    let mut registry = crate::projects::Registry::load()
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    // `is_open` as well as the registry: a project opened from a path the
    // registry has never heard of is still a name in use here.
    if registry.find(&name).is_some() || state.is_open(&name) {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            format!("a project named {name:?} already exists"),
        ));
    }
    let db = registry
        .joined_db_path(&name)
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    if let Some(existing) = registry.find_by_db(&db) {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            format!(
                "{name:?} would share a database with {:?} — pick a name that differs \
                 by more than punctuation",
                existing.name
            ),
        ));
    }
    if db.exists() {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            format!("{} already exists — pick another name", db.display()),
        ));
    }

    let store = Store::open(&db).map_err(|e| {
        ApiError::message(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not create {}: {e}", db.display()),
        )
    })?;
    let mut project = OpenProject::new(name.clone(), db.clone(), store);

    // Register before replicating, for the reason `main` does: the project
    // exists the moment its database does, and an endpoint that fails to
    // bind must not cost the name.
    if let Err(e) = registry.remember(&db, Some(&name), None) {
        tracing::warn!("could not register {name:?}: {e:#}");
    } else if let Err(e) = registry.save() {
        tracing::warn!("could not save the project registry: {e:#}");
    }

    if let Some(transport) = state.transport() {
        match yaiba_sync::SyncNode::start_with(Arc::clone(&project.store), transport).await {
            Ok(sync) => {
                tokio::spawn(Arc::clone(&sync).run(Arc::clone(&project.notify)));
                project.sync = Some(sync);
            }
            // Local-only is a worse project than a replicating one, but a
            // far better answer than refusing to create it at all.
            Err(e) => tracing::warn!("{name:?} starts without replication: {e:#}"),
        }
    }

    if !state.insert(project) {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            format!("a project named {name:?} is already open"),
        ));
    }
    Ok(Json(projects_response(&state)))
}

/// Close a project and drop it from the registry. Its database stays.
///
/// Closing is what makes this more than the CLI's `forget`: the project
/// stops replicating here and now, rather than at the next restart.
async fn forget_project(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Json<ProjectsResponse>> {
    if !state.is_open(&name) {
        return Err(ApiError::message(
            StatusCode::NOT_FOUND,
            format!("no open project named {name:?}"),
        ));
    }
    if state.remove(&name).is_none() {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            "this is the only open project — the server would have nothing to serve".to_string(),
        ));
    }

    match crate::projects::Registry::load() {
        Ok(mut registry) => {
            registry.forget(&name);
            if let Err(e) = registry.save() {
                tracing::warn!("could not save the project registry: {e:#}");
            }
        }
        Err(e) => tracing::warn!("could not read the project registry: {e:#}"),
    }
    Ok(Json(projects_response(&state)))
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
    let project = state.active();
    let store = lock(&project);
    respond_at(&store, query.asof)
}

async fn create_task(
    State(state): State<AppState>,
    Json(new): Json<NewTask>,
) -> ApiResult<Json<StateResponse>> {
    let project = state.active();
    let response = {
        let mut store = lock(&project);
        store.create_task(new)?;
        respond(&store)
    };
    project.notify.notify_one();
    response
}

async fn patch_task(
    State(state): State<AppState>,
    Path(id): Path<TaskId>,
    Json(patch): Json<TaskPatch>,
) -> ApiResult<Json<StateResponse>> {
    let project = state.active();
    let response = {
        let mut store = lock(&project);
        store.patch_task(id, patch)?;
        respond(&store)
    };
    project.notify.notify_one();
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
    let project = state.active();
    let response = {
        let mut store = lock(&project);
        store.put_task(&task)?;
        respond(&store)
    };
    project.notify.notify_one();
    response
}

async fn delete_task(
    State(state): State<AppState>,
    Path(id): Path<TaskId>,
) -> ApiResult<Json<StateResponse>> {
    let project = state.active();
    let response = {
        let mut store = lock(&project);
        store.delete_task(id)?;
        respond(&store)
    };
    project.notify.notify_one();
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
    let project = state.active();
    let response = {
        let mut store = lock(&project);
        store.reorder(&req.ids)?;
        respond(&store)
    };
    project.notify.notify_one();
    response
}

async fn add_dep(
    State(state): State<AppState>,
    Json(dep): Json<Dep>,
) -> ApiResult<Json<StateResponse>> {
    let project = state.active();
    let response = {
        let mut store = lock(&project);
        store.add_dep(dep.from, dep.to)?;
        respond(&store)
    };
    project.notify.notify_one();
    response
}

async fn remove_dep(
    State(state): State<AppState>,
    Path((from, to)): Path<(TaskId, TaskId)>,
) -> ApiResult<Json<StateResponse>> {
    let project = state.active();
    let response = {
        let mut store = lock(&project);
        store.remove_dep(from, to)?;
        respond(&store)
    };
    project.notify.notify_one();
    response
}

/// A poisoned mutex means an earlier handler panicked mid-transaction.
/// SQLite rolled that transaction back, so the data is still consistent
/// and carrying on beats taking the whole process down.
fn lock(project: &OpenProject) -> std::sync::MutexGuard<'_, Store> {
    project.store.lock().unwrap_or_else(|e| e.into_inner())
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
        let state = AppState::with_projects(vec![project("work"), project("default")], None);
        assert_eq!(state.active().name, "work");
    }

    #[test]
    fn switching_changes_which_store_is_served() {
        let state = AppState::with_projects(vec![project("work"), project("default")], None);
        let before = Arc::as_ptr(&state.active().store);

        assert!(state.switch("default"));
        assert_eq!(state.active().name, "default");
        assert_ne!(
            Arc::as_ptr(&state.active().store),
            before,
            "the handlers must reach a different database after a switch"
        );

        assert!(state.switch("work"));
        assert_eq!(Arc::as_ptr(&state.active().store), before);
    }

    #[test]
    fn switching_to_a_project_that_is_not_open_leaves_the_active_one_alone() {
        let state = AppState::with_projects(vec![project("work"), project("default")], None);
        assert!(!state.switch("nope"));
        assert_eq!(state.active().name, "work");
    }

    /// `AppState` is cloned per request by axum, and every clone has to
    /// see the same selection — otherwise a switch would apply to the one
    /// request that made it and nothing else.
    #[test]
    fn a_switch_is_visible_to_every_clone() {
        let state = AppState::with_projects(vec![project("work"), project("default")], None);
        let clone = state.clone();
        assert!(clone.switch("default"));
        assert_eq!(state.active().name, "default");
    }

    /// The reason `active` is a name and not an index: removing a project
    /// shifts every index after it, so an index would silently come to
    /// mean a different project.
    #[test]
    fn removing_a_project_before_the_active_one_does_not_move_the_view() {
        let state = AppState::with_projects(vec![project("a"), project("b"), project("c")], None);
        assert!(state.switch("c"));
        assert!(state.remove("a").is_some());
        assert_eq!(state.active().name, "c");
    }

    /// Forgetting what you are looking at has to land you somewhere, not
    /// leave `active` naming a project that is gone — `active()` panics on
    /// that, and it would be reachable from the UI.
    #[test]
    fn removing_the_active_project_moves_the_view_off_it() {
        let state = AppState::with_projects(vec![project("a"), project("b")], None);
        assert!(state.switch("a"));
        assert_eq!(state.remove("a").as_deref(), Some("b"));
        assert_eq!(state.active().name, "b");
        assert!(!state.is_open("a"));
    }

    /// A server with nothing open has no answer for any endpoint.
    #[test]
    fn the_last_project_cannot_be_removed() {
        let state = AppState::with_projects(vec![project("only")], None);
        assert!(state.remove("only").is_none());
        assert_eq!(state.active().name, "only");
    }

    #[test]
    fn a_new_project_is_opened_and_looked_at() {
        let state = AppState::with_projects(vec![project("a")], None);
        assert!(state.insert(project("b")));
        assert_eq!(state.active().name, "b");
        assert_eq!(state.projects().len(), 2);
    }

    /// Two projects under one name would make `switch` and `remove`
    /// ambiguous about which one they meant.
    #[test]
    fn a_duplicate_name_is_refused() {
        let state = AppState::with_projects(vec![project("a")], None);
        assert!(!state.insert(project("a")));
        assert_eq!(state.projects().len(), 1);
    }

    #[test]
    fn a_single_project_server_still_works() {
        let state = AppState::new(Store::open_in_memory().unwrap());
        assert_eq!(state.projects().len(), 1);
        assert!(state.active().sync.is_none());
    }
}
