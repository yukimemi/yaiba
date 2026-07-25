//! HTTP surface for the local UI.
//!
//! Every mutating endpoint answers with the *whole* application state
//! (tasks + edges + recomputed schedule). The dataset is small and a
//! single client is always looking at all of it, so returning the full
//! state removes a class of drift bugs — and with peers merging changes
//! in the background, a partial response would be stale the moment it
//! was built anyway.

use std::sync::{Arc, Mutex};

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use yaiba_core::{Dep, Error, NewTask, NodeId, Schedule, Store, Task, TaskId, TaskPatch, schedule};

#[derive(Clone)]
pub struct AppState {
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

impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            store: Arc::new(Mutex::new(store)),
            notify: Arc::new(tokio::sync::Notify::new()),
            sync: None,
        }
    }
}

/// Everything the client needs to render, in one payload.
#[derive(Serialize)]
pub struct StateResponse {
    tasks: Vec<Task>,
    deps: Vec<Dep>,
    schedule: Schedule,
    today: NaiveDate,
    /// This replica's id — shown in the UI so you can tell whose peer
    /// list you are looking at.
    node_id: NodeId,
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
        .with_state(state)
}

#[derive(Serialize)]
pub struct PeersResponse {
    /// Hand this to someone to bring them into this dataset. `None`
    /// when the replica was started with `--no-sync`.
    ticket: Option<String>,
    peers: Vec<String>,
}

async fn get_peers(State(state): State<AppState>) -> Json<PeersResponse> {
    let Some(sync) = &state.sync else {
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
    let Some(sync) = state.sync.clone() else {
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
    let snapshot = store.snapshot()?;
    let today = Local::now().date_naive();
    let schedule = schedule(&snapshot.tasks, &snapshot.deps, today);
    Ok(Json(StateResponse {
        tasks: snapshot.tasks,
        deps: snapshot.deps,
        schedule,
        today,
        node_id: store.node_id(),
    }))
}

async fn get_state(State(state): State<AppState>) -> ApiResult<Json<StateResponse>> {
    let store = lock(&state);
    respond(&store)
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
    state.notify.notify_one();
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
    state.notify.notify_one();
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
    state.notify.notify_one();
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
    state.notify.notify_one();
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
    state.notify.notify_one();
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
    state.notify.notify_one();
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
    state.notify.notify_one();
    response
}

/// A poisoned mutex means an earlier handler panicked mid-transaction.
/// SQLite rolled that transaction back, so the data is still consistent
/// and carrying on beats taking the whole process down.
fn lock(state: &AppState) -> std::sync::MutexGuard<'_, Store> {
    state.store.lock().unwrap_or_else(|e| e.into_inner())
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
                    // A cycle or a self-edge is a legal request against
                    // an illegal state transition — that's what 409 is.
                    Error::Cycle { .. } | Error::SelfDep => StatusCode::CONFLICT,
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
