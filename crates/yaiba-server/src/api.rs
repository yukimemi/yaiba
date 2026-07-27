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
    /// Handle on the background replication loop, so closing a project can
    /// actually stop it.
    ///
    /// That loop owns `Arc`s to the store and the notify, so dropping the
    /// project from the open set does not end it. Without this it would go
    /// on replicating a project the server no longer considers open, for
    /// the life of the process.
    pub replication: Option<tokio::task::AbortHandle>,
}

impl OpenProject {
    pub fn new(name: impl Into<String>, db: PathBuf, store: Store) -> Self {
        Self {
            name: name.into(),
            db,
            store: Arc::new(Mutex::new(store)),
            notify: Arc::new(tokio::sync::Notify::new()),
            sync: None,
            replication: None,
        }
    }

    /// Start replicating, keeping hold of the task so it can be stopped.
    pub fn replicate(&mut self, sync: Arc<yaiba_sync::SyncNode>) {
        let task = tokio::spawn(Arc::clone(&sync).run(Arc::clone(&self.notify)));
        self.replication = Some(task.abort_handle());
        self.sync = Some(sync);
    }

    /// Stop replicating, in **both** directions.
    ///
    /// Aborting the driver silences only what this replica sends. The sync
    /// node runs its own accept loop, which would go on answering dials
    /// and merging peer writes into a store the server no longer considers
    /// open — so the node is shut down as well.
    ///
    /// Idempotent, and a no-op on a project that never started either:
    /// `--no-sync`, or an endpoint that failed to bind.
    pub fn stop_replicating(&self) {
        if let Some(task) = &self.replication {
            task.abort();
        }
        if let Some(sync) = &self.sync {
            sync.shutdown();
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    /// The open set and which one is being looked at, under **one** lock.
    ///
    /// They started as two locks with a documented acquisition order, and
    /// that was wrong: "is it open?" and "make it active" have to be a
    /// single critical section, or a concurrent removal lands between them
    /// and `active` is left naming a project that is gone. One lock makes
    /// that unrepresentable instead of merely documented.
    open: Arc<Mutex<Open>>,
    /// Serializes every read-modify-write of the registry file.
    ///
    /// `Registry::save` writes the whole project list rather than a diff,
    /// so two handlers that each load a snapshot, change their own copy
    /// and save will have the later save silently drop the earlier one's
    /// change — even for unrelated projects, and with no `.await` gap
    /// needed, since axum's runtime is multi-threaded.
    ///
    /// Async because creation holds it across an endpoint bind, which a
    /// `std` guard cannot span. Holding it there also reserves the name:
    /// creation checks and registers under one hold.
    registry: Arc<tokio::sync::Mutex<()>>,
    /// How a project created at runtime gets its replication, so it comes
    /// up the same way one opened at startup did. `None` under
    /// `--no-sync`, which is the whole reason this is an `Option`.
    transport: Option<yaiba_sync::Transport>,
}

/// The open projects, and the name of the one being looked at.
///
/// A name rather than an index: removing a project shifts every index
/// after it, so an index would quietly come to mean a different project,
/// while a name either keeps meaning the same thing or stops resolving.
struct Open {
    projects: Vec<Arc<OpenProject>>,
    active: String,
}

impl Open {
    fn has(&self, name: &str) -> bool {
        self.projects.iter().any(|p| p.name == name)
    }
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
            open: Arc::new(Mutex::new(Open {
                active: projects[0].name.clone(),
                projects: projects.into_iter().map(Arc::new).collect(),
            })),
            registry: Arc::new(tokio::sync::Mutex::new(())),
            transport,
        }
    }

    pub fn transport(&self) -> Option<yaiba_sync::Transport> {
        self.transport
    }

    fn open(&self) -> std::sync::MutexGuard<'_, Open> {
        self.open.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Take the registry lock. Hold it across the whole load-mutate-save
    /// span, not just the save — the read is half of the race.
    pub async fn registry(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.registry.lock().await
    }

    /// Point the server at a different open project. `false` if no project
    /// goes by that name.
    ///
    /// The check and the write share one critical section: split, a
    /// concurrent `remove` between them makes this activate a project that
    /// no longer exists.
    pub fn switch(&self, name: &str) -> bool {
        let mut open = self.open();
        if !open.has(name) {
            return false;
        }
        open.active = name.to_string();
        true
    }

    /// The project being looked at.
    ///
    /// Returns a handle rather than a reference, so the lock is released
    /// before the caller goes on to take the store's — holding it for as
    /// long as a caller wants the project would serialize every request
    /// against every other one.
    ///
    /// # Panics
    /// If the active name resolves to nothing. Every mutation of the set
    /// happens under the same lock as `active`, so that is a bug in this
    /// type rather than a reachable state.
    pub fn active(&self) -> Arc<OpenProject> {
        let open = self.open();
        open.projects
            .iter()
            .find(|p| p.name == open.active)
            .cloned()
            .unwrap_or_else(|| panic!("the active project {:?} is not open", open.active))
    }

    pub fn projects(&self) -> Vec<Arc<OpenProject>> {
        self.open().projects.clone()
    }

    pub fn is_open(&self, name: &str) -> bool {
        self.open().has(name)
    }

    /// Take a newly created project into the open set and look at it.
    ///
    /// Hands the project back on failure rather than returning a bool: it
    /// owns a running replication task, and a caller that cannot reach it
    /// again has no way to stop it. The name being taken means two
    /// projects under one name, which would make `switch`, `rename` and
    /// `remove` ambiguous.
    pub fn insert(&self, project: OpenProject) -> Result<(), OpenProject> {
        let mut open = self.open();
        if open.has(&project.name) {
            return Err(project);
        }
        open.active = project.name.clone();
        open.projects.push(Arc::new(project));
        Ok(())
    }

    /// Close a project, moving off it first if it is the one being looked
    /// at. Returns the name now active, or `None` if nothing was removed.
    ///
    /// Stops its replication as part of removing it, rather than leaving
    /// that to the caller: "closed" has to mean the loop is not still
    /// syncing a project the server no longer holds.
    ///
    /// Refuses to remove the last one: the server would then have no state
    /// to serve and every endpoint would have nothing to answer with.
    pub fn remove(&self, name: &str) -> Option<String> {
        let mut open = self.open();
        if open.projects.len() <= 1 {
            return None;
        }
        let at = open.projects.iter().position(|p| p.name == name)?;
        let closed = open.projects.remove(at);
        closed.stop_replicating();
        if open.active == name {
            // The one that took its place, or the last if it was last.
            let next = at.min(open.projects.len() - 1);
            open.active = open.projects[next].name.clone();
        }
        Some(open.active.clone())
    }

    /// Rename an open project. `false` if it isn't open, or if the new
    /// name is already taken by another one.
    ///
    /// Only the name moves — the database keeps the path it was created
    /// with, because identity here *is* the path and moving a live SQLite
    /// file (with its WAL and shm siblings, possibly open elsewhere) buys
    /// nothing but tidiness.
    pub fn rename(&self, from: &str, to: &str) -> bool {
        let mut open = self.open();
        if !open.has(from) || open.has(to) {
            return false;
        }
        let Some(at) = open.projects.iter().position(|p| p.name == from) else {
            return false;
        };
        // `OpenProject` sits behind an `Arc` shared with the sync task, so
        // rebuild the entry rather than mutating through it.
        let old = &open.projects[at];
        let renamed = Arc::new(OpenProject {
            name: to.to_string(),
            db: old.db.clone(),
            store: Arc::clone(&old.store),
            notify: Arc::clone(&old.notify),
            sync: old.sync.clone(),
            // Carried over, not dropped: the loop is still the same one,
            // and losing the handle here would make the project
            // unstoppable if it were closed later.
            replication: old.replication.clone(),
        });
        open.projects[at] = renamed;
        if open.active == from {
            open.active = to.to_string();
        }
        true
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
            axum::routing::delete(forget_project).patch(rename_project),
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
    // Held across the whole check-create-insert, which spans an await.
    // Two requests for the same name would otherwise both pass the checks
    // and the loser would 409 having already left a database, a registry
    // entry and a sync task behind.
    let _registry = state.registry().await;

    let name = crate::projects::validate_name(&req.name)
        .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, e.to_string()))?
        .to_string();

    let mut registry = crate::projects::Registry::load()
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    // `is_open` as well as the registry: a project opened from a path the
    // registry has never heard of is still a name in use here.
    if state.is_open(&name) {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            format!("a project named {name:?} is already open"),
        ));
    }
    // The same rules the CLI's `new` and `join` use, from the same
    // function — a second way in must not be a way around them.
    let db = crate::projects::db_for_new_project(&registry, &name, None, "a different name")
        .map_err(|e| ApiError::message(StatusCode::CONFLICT, format!("{e:#}")))?;

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
            Ok(sync) => project.replicate(sync),
            // Local-only is a worse project than a replicating one, but a
            // far better answer than refusing to create it at all.
            Err(e) => tracing::warn!("{name:?} starts without replication: {e:#}"),
        }
    }

    if let Err(rejected) = state.insert(project) {
        // The registry lock keeps two creates apart, but a `rename` can
        // still claim the name across the await above. Undo it rather than
        // return 409 on top of a live sync task replicating a project the
        // server does not hold, and a registry entry for the same.
        rejected.stop_replicating();
        drop(rejected);
        forget_by_db(&db);
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            format!("a project named {name:?} is already open"),
        ));
    }
    Ok(Json(projects_response(&state)))
}

/// Drop whatever registry entry points at `db`.
///
/// Assumes the caller holds the registry lock — its only caller is the
/// creation path, which does.
///
/// By path rather than by name: the entry may have been filed under a
/// uniquified name, and the path is what identifies it either way. The
/// database file itself is left alone — deleting one on an error path is
/// how an error becomes a loss, and an empty stray file is inert.
fn forget_by_db(db: &std::path::Path) {
    // First, because it is the line that explains a later refusal to reuse
    // this name — and the two early returns below are exactly the cases
    // where the registry could not be tidied, so it is needed most there.
    tracing::warn!(
        "that project was not opened after all; its empty database is still at {}",
        db.display()
    );
    let Ok(mut registry) = crate::projects::Registry::load() else {
        return;
    };
    let Some(name) = registry.find_by_db(db).map(|p| p.name.clone()) else {
        return;
    };
    registry.forget(&name);
    if let Err(e) = registry.save() {
        tracing::warn!("could not drop the half-created {name:?}: {e:#}");
    }
}

#[derive(Deserialize)]
struct RenameRequest {
    to: String,
}

/// Rename a project. Only the name moves.
///
/// The database keeps the path it was created with — identity here *is*
/// the path, and moving a live SQLite file with its WAL and shm siblings
/// buys nothing but tidiness. So a project renamed from `private` to
/// `personal` still lives in `projects/private.db`, and a later
/// `new private` is refused because that file is taken.
async fn rename_project(
    State(state): State<AppState>,
    Path(from): Path<String>,
    Json(req): Json<RenameRequest>,
) -> ApiResult<Json<ProjectsResponse>> {
    let to = crate::projects::validate_name(&req.to)
        .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, e.to_string()))?
        .to_string();
    if from == to {
        return Ok(Json(projects_response(&state)));
    }
    // Held across everything below — both the registry's load-mutate-save
    // and the in-memory rename. `forget_project` takes it before it closes
    // anything, so within this hold the open set cannot move underneath
    // us: without that, a forget landing between the registry save and
    // `state.rename` leaves the registry renamed while this answers 409.
    let _registry = state.registry().await;

    // Checked under the lock, not before it. Before, a forget could land
    // while this was still waiting for the lock, and the check would have
    // been answered about a project that is no longer open.
    if !state.is_open(&from) {
        return Err(ApiError::message(
            StatusCode::NOT_FOUND,
            format!("no open project named {from:?}"),
        ));
    }

    // The registry goes first, and its refusal is the answer.
    //
    // It knows about projects this server does not hold open — a
    // registered but closed one can own `to`. Renaming memory first and
    // warning on the registry failure would answer 200 to a rename that
    // the next start silently undoes, with `to` by then meaning two
    // different projects.
    let mut registry = crate::projects::Registry::load()
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    if registry.find(&from).is_some() {
        registry
            .rename(&from, &to)
            .map_err(|e| ApiError::message(StatusCode::CONFLICT, format!("{e:#}")))?;
        registry
            .save()
            .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    } else if registry.find(&to).is_some() {
        // Not registered under `from` — opened by path, say — but `to` is
        // taken by something else on disk.
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            format!("a project named {to:?} is already registered"),
        ));
    }

    if !state.rename(&from, &to) {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            format!("a project named {to:?} is already open"),
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
    // Taken before anything is closed, so the whole forget — the open set
    // *and* the registry — is one span against `rename_project`. Closing
    // first and locking after let a rename that already held the lock see
    // the project vanish between its registry save and its own
    // `state.rename`, leaving the registry moved and the response a 409.
    let _registry = state.registry().await;

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
        assert!(state.insert(project("b")).is_ok());
        assert_eq!(state.active().name, "b");
        assert_eq!(state.projects().len(), 2);
    }

    /// Two projects under one name would make `switch` and `remove`
    /// ambiguous about which one they meant.
    #[test]
    fn a_duplicate_name_is_refused() {
        let state = AppState::with_projects(vec![project("a")], None);
        assert!(state.insert(project("a")).is_err());
        assert_eq!(state.projects().len(), 1);
    }

    #[test]
    fn renaming_carries_the_store_and_the_view() {
        let state = AppState::with_projects(vec![project("a"), project("b")], None);
        let store = Arc::as_ptr(&state.active().store);

        assert!(state.rename("a", "alpha"));
        assert_eq!(state.active().name, "alpha", "the view follows the rename");
        // Same database behind the new name — a rename must not look like
        // a switch to the handlers.
        assert_eq!(Arc::as_ptr(&state.active().store), store);
        assert!(!state.is_open("a"));
    }

    #[test]
    fn renaming_onto_an_open_name_is_refused() {
        let state = AppState::with_projects(vec![project("a"), project("b")], None);
        assert!(!state.rename("a", "b"));
        assert!(state.is_open("a") && state.is_open("b"));
    }

    #[test]
    fn renaming_a_project_that_is_not_open_is_refused() {
        let state = AppState::with_projects(vec![project("a")], None);
        assert!(!state.rename("nope", "x"));
    }

    #[test]
    fn a_single_project_server_still_works() {
        let state = AppState::new(Store::open_in_memory().unwrap());
        assert_eq!(state.projects().len(), 1);
        assert!(state.active().sync.is_none());
    }
}
