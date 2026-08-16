//! HTTP surface for the local UI.
//!
//! Every mutating endpoint answers with the *whole* application state
//! (tasks + edges + recomputed schedule). The dataset is small and a
//! single client is always looking at all of it, so returning the full
//! state removes a class of drift bugs — and with peers merging changes
//! in the background, a partial response would be stale the moment it
//! was built anyway.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::{Local, Months, NaiveDate};
use serde::{Deserialize, Serialize};
use yaiba_core::{
    Calendar, CalendarMode, DayMark, Dep, Error, HolidaySet, NewTask, NodeId, Schedule, Store,
    Task, TaskId, TaskPatch, schedule,
};

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
    /// Where machine-level credentials are read from. `None` means the
    /// real one, under the data directory.
    ///
    /// Overridable so that tests are not sharing a file with the person
    /// running them. Without it a handler test reads whatever Google
    /// credential the developer happens to be logged in with, and
    /// `push_gcal` goes on to make live API calls with it.
    credentials: Option<PathBuf>,
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
            credentials: None,
        }
    }

    /// Read credentials from here rather than from the data directory.
    pub fn with_credentials_path(mut self, path: PathBuf) -> Self {
        self.credentials = Some(path);
        self
    }

    /// The credentials file this server reads.
    pub fn credentials_path(&self) -> anyhow::Result<PathBuf> {
        match &self.credentials {
            Some(path) => Ok(path.clone()),
            None => crate::credentials::default_path(),
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
    /// The working calendar, already resolved to dates. See
    /// [`CalendarView`].
    calendar: CalendarView,
}

/// The calendar as the client draws it: the settings, plus the days they
/// work out to over a bounded window.
///
/// Resolved here rather than in the browser for the same reason `schedule`
/// is: a holiday table — substitute holidays, the equinox approximation,
/// whatever a region needs — is one answer to one question, and a
/// TypeScript copy of it would be a second, one that disagrees with the
/// dates the bars are drawn at the first time either side is fixed.
#[derive(Serialize)]
pub struct CalendarView {
    mode: CalendarMode,
    /// Seven flags, **Monday first**, in the same order the store holds
    /// them. Not rotated for a locale: the client indexes it by weekday
    /// number, and an order that depended on language would be a bug that
    /// only appears in one.
    week: [bool; 7],
    /// Which built-in holiday table applies, by name. Called `region`
    /// rather than `holidays` because the resolved map below has the
    /// better claim to that word, and `jp: true` would have been the
    /// wrong shape besides: the table is one option among however many
    /// get added, not a yes/no about Japan.
    region: HolidaySet,
    /// Day off → its name, empty when nobody named it. Holidays and
    /// hand-marked closures only — **weekends are not listed**, because
    /// the client has `week` and can shade them itself. Listing them would
    /// put well over a thousand dates in every state response to say what
    /// seven booleans already say.
    ///
    /// A holiday that lands on a weekend *is* listed, though: it is a
    /// weekend either way, but only this map knows its name for the day
    /// cell's tooltip.
    holidays: BTreeMap<NaiveDate, String>,
    /// Days worked despite the week mask or the holiday table — the
    /// make-up Saturday.
    workdays: Vec<NaiveDate>,
}

/// How far either side of `today` the calendar is resolved.
///
/// Bounded because the resolution is a *preview*: the client needs shading
/// and tooltips for the range a person can scroll to, not for every year
/// the equinox formula covers. Asymmetric because plans point forwards —
/// a year back covers looking at what happened, three years on covers any
/// plan long enough to care about holidays. Outside the window the client
/// falls back to the week mask alone, which is honest rather than wrong:
/// the scheduler on this side always uses the full calendar, so the dates
/// stay right even where the shading stops.
const CALENDAR_BACK: Months = Months::new(12);
const CALENDAR_FORWARD: Months = Months::new(36);

impl CalendarView {
    /// Resolve `cal` into dates around `today`.
    fn resolve(cal: &Calendar, today: NaiveDate) -> Self {
        // Saturating rather than unwrapping: `today` comes from the
        // system clock or from `:asof`, and a machine set to year 262143
        // must not take the state endpoint down with it.
        let from = today
            .checked_sub_months(CALENDAR_BACK)
            .unwrap_or(NaiveDate::MIN);
        let to = today
            .checked_add_months(CALENDAR_FORWARD)
            .unwrap_or(NaiveDate::MAX);
        Self {
            mode: cal.mode,
            week: cal.week,
            region: cal.holidays,
            // `off_days` answers exactly what belongs here — the closures
            // the week mask cannot explain, named. Walking the window with
            // `is_working` instead would both bury the response in weekends
            // and lose the name of a holiday that falls on one.
            holidays: cal.off_days(from, to).into_iter().collect(),
            workdays: cal.working_overrides(from, to),
        }
    }
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
        // No GET of its own: the calendar is part of every state response,
        // so a second way to read it would be a second thing that can be
        // stale.
        .route("/api/calendar", axum::routing::put(put_calendar))
        .route("/api/peers", get(get_peers))
        .route("/api/peers/merge", post(merge_peer))
        .route("/api/peers/leave", post(leave_peers))
        .route("/api/ui", get(get_ui).put(put_ui))
        .route("/api/gcal/push", post(push_gcal))
        .route("/api/projects", get(get_projects).post(switch_project))
        .route("/api/projects/new", post(create_project))
        .route("/api/projects/join", post(join_project))
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

/// Start a project of your own and open it, without restarting.
async fn create_project(
    State(state): State<AppState>,
    Json(req): Json<SwitchRequest>,
) -> ApiResult<Json<ProjectsResponse>> {
    open_new_project(&state, &req.name, None).await
}

#[derive(Deserialize)]
struct JoinProjectRequest {
    ticket: String,
    /// File it under this name. Defaults to a name from the ticket, the
    /// same way `yaiba join` without `--as` does.
    #[serde(default)]
    name: Option<String>,
}

/// Take a peer's tasks as a *separate* project, and open it.
///
/// The UI's counterpart to `yaiba join <ticket>`, and the reason `:join`
/// there is no longer the merge: this used to be impossible from a
/// running server, because one process held one database. It holds every
/// project now, each with its own [`SyncNode`], so the safe reading of
/// "join" is reachable from the UI — and it is the one people expect.
///
/// [`SyncNode`]: yaiba_sync::SyncNode
async fn join_project(
    State(state): State<AppState>,
    Json(req): Json<JoinProjectRequest>,
) -> ApiResult<Json<ProjectsResponse>> {
    // Parsed before anything is created, as the CLI does: a mistyped
    // ticket should not cost a database and a registry entry.
    let ticket: yaiba_sync::Ticket =
        req.ticket.trim().parse().map_err(|e: anyhow::Error| {
            ApiError::message(StatusCode::BAD_REQUEST, format!("{e:#}"))
        })?;
    let name = match &req.name {
        Some(given) => given.clone(),
        None => crate::projects::name_from_ticket(req.ticket.trim()),
    };
    open_new_project(&state, &name, Some(ticket)).await
}

/// Create a database, register it, open it, and — given a ticket — join
/// its replica to that peer.
///
/// Goes through the same registry rules the CLI's `yaiba new` and
/// `yaiba join` do — a name already registered, a name whose slug lands
/// on another project's database, a database left behind by an earlier
/// `forget` — because a second way in must not be a way around them. For
/// the same reason there is one function behind both HTTP routes: "start
/// a project" and "start a project holding someone else's tasks" differ
/// by a ticket and nothing else.
async fn open_new_project(
    state: &AppState,
    requested: &str,
    ticket: Option<yaiba_sync::Ticket>,
) -> ApiResult<Json<ProjectsResponse>> {
    // Held across the whole check-create-insert, which spans an await.
    // Two requests for the same name would otherwise both pass the checks
    // and the loser would 409 having already left a database, a registry
    // entry and a sync task behind.
    let registry_guard = state.registry().await;

    let name = crate::projects::validate_name(requested)
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
    //
    // Only an adopted project carries a ticket, matching what `yaiba list`
    // means by `(joined)` — a project started here came from nobody.
    let joined_from = ticket.as_ref().map(ToString::to_string);
    if let Err(e) = registry.remember(&db, Some(&name), joined_from.as_deref()) {
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

    // Refuse rather than half-deliver: a project asked for by ticket whose
    // endpoint never bound is an empty database wearing the peer's name,
    // and it would sit there filling with nothing while looking joined.
    // Nothing has been inserted yet, so the undo is the same one the
    // conflict path below performs.
    if ticket.is_some() && project.sync.is_none() {
        project.stop_replicating();
        drop(project);
        forget_by_db(&db);
        return Err(ApiError::message(
            StatusCode::SERVICE_UNAVAILABLE,
            "cannot join a peer without replication — this server was started with --no-sync, \
             or its endpoint could not bind",
        ));
    }

    // Taken before the move, so the pull below needs no lookup — and so
    // it cannot accidentally reach a *different* project that claimed the
    // name in between.
    let sync = project.sync.clone();

    // Adopting the ticket and pulling from the peer read as one step and
    // are not one: `join` is a local, synchronous write of the room key
    // and the peer row, so it fails on a ticket naming this very replica
    // or on a store error, and *never* on the peer being unreachable.
    // Fatal, therefore, and fatal here — the registry entry already
    // carries `joined_from`, so a project that survived this would be
    // listed `(joined)` and report success having joined nobody, which is
    // exactly the half-delivery the branch above refuses. Before the
    // insert, so the undo is the same two lines that branch uses rather
    // than also having to take the project back out of the open set.
    //
    // `merge_peer` and the CLI both treat the identical call as fatal.
    if let (Some(ticket), Some(sync)) = (ticket.as_ref(), sync.as_ref())
        && let Err(e) = sync.join(ticket)
    {
        project.stop_replicating();
        drop(project);
        forget_by_db(&db);
        return Err(ApiError::message(
            StatusCode::BAD_REQUEST,
            format!("could not adopt that ticket: {e:#}"),
        ));
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

    // Released before the pull, which is the one await here that waits on
    // somebody else's machine — up to `EXCHANGE` per peer. What the lock
    // protects is the check-create-insert above, and all three are done:
    // the registry file is written and the open set holds the project.
    // Kept any longer it would stall every other create, rename and forget
    // on a peer that is merely switched off.
    drop(registry_guard);

    // The pull is the half that talks to the network, and this is where a
    // peer that is simply switched off is the ordinary case rather than an
    // error: the ticket is already stored, the driver retries on its own
    // timer, and none of that is worth undoing a project over. Run at all
    // so joining has a visible effect rather than waiting out the first
    // idle tick, and after the insert so what it merges lands in a project
    // the server is holding.
    if let (true, Some(sync)) = (ticket.is_some(), sync) {
        sync.sync_all().await;
    }

    Ok(Json(projects_response(state)))
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
    // After the existence check, not before it: renaming something to the
    // name it already has is a no-op *for a project that exists*, and a
    // shortcut that skips validation turns a 404 into a 200.
    if from == to {
        return Ok(Json(projects_response(&state)));
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
struct MergeRequest {
    ticket: String,
}

/// Merge the active project into the peer's group, then sync immediately
/// so it has a visible effect rather than waiting for the next tick.
///
/// Mutual and not undoable — both task sets end up in both replicas, and
/// this project leaves its own sync room. It was called `join` and shared
/// that name with the CLI subcommand that does the *opposite*; splitting
/// them is the whole point of this route's name. [`join_project`] is the
/// other reading, and the one the UI's `:join` now reaches.
async fn merge_peer(
    State(state): State<AppState>,
    Json(req): Json<MergeRequest>,
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

#[derive(Serialize)]
struct LeaveResponse {
    /// How many peers were dropped, so the answer can say what it cut
    /// rather than assert that there had been anything to cut.
    dropped: usize,
    #[serde(flatten)]
    peers: PeersResponse,
}

/// Cut the active project loose: forget its peers, and mint a new room.
///
/// The way back out of both [`merge_peer`] and [`join_project`], and until
/// this there was not one — leaving meant deleting rows from `peers` and
/// `meta` by hand, which is a lot to ask of somebody who has just worked
/// out they merged the wrong thing.
///
/// Not undoable, and not apologetic about it: the ticket changes, so every
/// replica holding the old one is cut off — including the user's own other
/// machines. What it cannot do is take anything back, since whatever
/// already synced is on the other side's disk for good.
async fn leave_peers(
    State(state): State<AppState>,
) -> std::result::Result<Json<LeaveResponse>, ApiError> {
    let project = state.active();
    let Some(sync) = project.sync.clone() else {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            "this replica was started with --no-sync",
        ));
    };
    let dropped = sync
        .leave()
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;

    // Under the lock, like every other read-modify-write of the file.
    // Best-effort on purpose: the group has already been left by the time
    // this runs, so failing the call over a stale label would leave the
    // two disagreeing in the worse of the two directions — a replica that
    // is out, reporting itself in.
    let _registry = state.registry().await;
    match crate::projects::Registry::load() {
        Ok(mut registry) => {
            if registry.clear_joined_from(&project.db)
                && let Err(e) = registry.save()
            {
                tracing::warn!("left the group, but the registry still says joined: {e:#}");
            }
        }
        Err(e) => tracing::warn!("left the group, but the registry could not be read: {e:#}"),
    }

    Ok(Json(LeaveResponse {
        dropped,
        peers: PeersResponse {
            ticket: Some(sync.ticket().to_string()),
            peers: sync.peer_ids().iter().map(|id| id.to_string()).collect(),
        },
    }))
}

/// Where the active project's UI state lives in the store.
///
/// `meta` rather than the CRDT log, on purpose: folds and filters are how
/// *this* replica likes to look at the plan, not part of the plan, so they
/// must not sync to peers. And because `meta` sits in the project's own
/// database, the state is per-project and survives a rename (which keeps
/// the database) for free.
const META_UI: &str = "ui";

async fn get_ui(State(state): State<AppState>) -> ApiResult<Json<serde_json::Value>> {
    let project = state.active();
    let store = lock(&project);
    let saved = store.meta(META_UI)?;
    // A blob that no longer parses (hand-edited, written by a newer
    // version) reads as "nothing saved" — the UI state is a convenience,
    // and losing it must never break the app.
    let ui = saved
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    Ok(Json(ui))
}

async fn put_ui(
    State(state): State<AppState>,
    Json(ui): Json<serde_json::Value>,
) -> ApiResult<Json<serde_json::Value>> {
    let text = serde_json::to_string(&ui)
        .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, e.to_string()))?;
    let project = state.active();
    let store = lock(&project);
    store.set_meta(META_UI, &text)?;
    // No `notify` bump: `meta` is not part of the CRDT log, so there is
    // nothing for the sync layer to push.
    Ok(Json(ui))
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
    let schedule = schedule(&snapshot.tasks, &snapshot.deps, today, &snapshot.calendar);
    // Resolved against the same `today` the bars are, so the shading and
    // the dates can never disagree about which window is being looked at.
    let calendar = CalendarView::resolve(&snapshot.calendar, today);
    Ok(Json(StateResponse {
        tasks: snapshot.tasks,
        deps: snapshot.deps,
        schedule,
        today,
        // "A date was supplied" is not the same as "this isn't now":
        // `:asof today` supplies one and is still the live view.
        as_of: today != Local::now().date_naive(),
        node_id: store.node_id(),
        calendar,
    }))
}

/// Make the calendar say what the plan says.
async fn push_gcal(State(state): State<AppState>) -> ApiResult<Json<crate::gcal::push::Outcome>> {
    let creds = crate::gcal::oauth::Credentials::from_env()
        .map_err(|e| ApiError::message(StatusCode::PRECONDITION_FAILED, format!("{e:#}")))?;

    let project = state.active();
    // Read everything the run needs, then drop the lock. The push awaits
    // on the network, and a `std::sync::Mutex` held across an await would
    // put every other request behind Google's rate limiter.
    // `calendar` here is the *Google* calendar this project pushes to;
    // `cal` is the working calendar the dates are counted in. Two
    // different things that unavoidably share a word.
    let (token, calendar, tasks, deps, cal) = {
        let store = lock(&project);
        let token = state
            .credentials_path()
            .and_then(|path| crate::gcal::oauth::stored_at(&path))
            .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?
            .ok_or_else(|| {
                // Not "this project has no credential": the credential is
                // the machine's, and saying otherwise would steer people
                // back to the per-project model #168 removed.
                ApiError::message(
                    StatusCode::PRECONDITION_FAILED,
                    "no Google credential on this machine yet — run `yaiba gcal login`",
                )
            })?;
        let calendar = store.meta(crate::gcal::oauth::KEY_CALENDAR)?;
        let snapshot = store.snapshot()?;
        (
            token,
            calendar,
            snapshot.tasks,
            snapshot.deps,
            snapshot.calendar,
        )
    };

    // Today's schedule, not an as-of one: a calendar is what is going to
    // happen, and `:asof` is a way of looking at what was.
    let today = Local::now().date_naive();
    let plan = schedule(&tasks, &deps, today, &cal);
    let title = crate::gcal::calendar_title(&project.name);

    let outcome =
        crate::gcal::push::run(&creds, &token, calendar.as_deref(), &title, &tasks, &plan)
            .await
            .map_err(|e| ApiError::message(StatusCode::BAD_GATEWAY, format!("{e:#}")))?;

    // Filed after the run rather than before, so a calendar that could
    // not be created leaves nothing behind claiming it was.
    if calendar.as_deref() != Some(outcome.calendar.as_str()) {
        let store = lock(&project);
        store.set_meta(crate::gcal::oauth::KEY_CALENDAR, &outcome.calendar)?;
    }
    Ok(Json(outcome))
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
        // `lag_days` defaults to 1 when the body omits it, so a client
        // that predates the field posts `{from, to}` and gets the edge it
        // has always got.
        store.add_dep(dep.from, dep.to, dep.lag_days)?;
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

/// Patch for `PUT /api/calendar`. An omitted key is left alone.
///
/// Patch rather than replace because the four parts are set from four
/// different places — `:cal on`, `:cal week`, `:cal region`, `:cal holiday`
/// — and a whole-document PUT would make each of them read the calendar
/// first and re-send the rest, which is a lost update waiting for two
/// people to type at once.
#[derive(Deserialize)]
struct CalendarPatch {
    /// Taken as a plain string and parsed by hand, so an unknown mode is
    /// the same `{"error": …}` 400 as every other refusal on this route.
    /// Typed as `Option<CalendarMode>` it was serde's derive that refused
    /// it, which is a 422 of `text/plain` — a caller cannot parse the
    /// errors from one endpoint two different ways, and the client renders
    /// the server's own sentence. `CalendarMode::ALL` keeps the valid
    /// values spelled in one place regardless.
    #[serde(default)]
    mode: Option<String>,
    /// Seven `true`/`false`, Monday first — but taken as raw JSON and
    /// checked by hand, for the same reason as `mode`. Typed
    /// `Option<Vec<bool>>` the *length* was a 400 while an element of the
    /// wrong type was serde's 422 of `text/plain`, and `[1,1,1,1,1,0,0]`
    /// is the likeliest way to get this wrong. Every field on this route is
    /// tolerant here and strict in the handler, so that the promise "every
    /// refusal is a 400 with a sentence in it" is true rather than nearly
    /// true.
    #[serde(default)]
    week: Option<serde_json::Value>,
    /// Which built-in holiday table to use: `"none"` or `"jp"`. Parsed by
    /// hand for the same reason as `mode`.
    #[serde(default)]
    region: Option<String>,
    /// Date → `"name"` | `true` (unnamed day off) | `false` (worked
    /// anyway) | `null` (no opinion, back to the week mask and the
    /// holiday table).
    ///
    /// A whole map, not one day per request. This is the general escape
    /// hatch the built-in tables are only a shortcut for: somewhere with
    /// no table of its own posts its year in one call, and gets data that
    /// means the same thing on every version rather than a region name
    /// that needs the right binary to read.
    ///
    /// A key present with `null` is how a mark is *removed*, which is why
    /// this is a map of values rather than of marks: absence and null have
    /// to stay different things, the way `TaskPatch` keeps them apart for
    /// the dates.
    #[serde(default)]
    days: Option<serde_json::Value>,
}

/// Change the working calendar.
///
/// Everything is validated before anything is written. The four settings
/// are four CRDT rows and therefore four commits, so a refusal discovered
/// halfway through would leave a calendar nobody asked for — and unlike a
/// rejected task edit, a half-applied calendar moves every bar in the
/// plan.
///
/// The refusals here are stricter than the store's, on purpose. A
/// [`Calendar`] that reads a week of all `false` treats it as *every* day
/// working, because it may have arrived from a peer and a scheduler that
/// cannot place a bar is worse than one that ignores a nonsense mask. This
/// route is the other side of that: a person typing "no working days" has
/// made a mistake and wants to hear about it, and nothing is lost by
/// saying so — the degradation stays as the safety net it was written to
/// be, rather than becoming the way the setting is normally reached.
async fn put_calendar(
    State(state): State<AppState>,
    Json(patch): Json<CalendarPatch>,
) -> ApiResult<Json<StateResponse>> {
    // Both enums are parsed before anything is written, and both name the
    // values they would have accepted: an unknown one is a typo, and a
    // refusal that does not say what was allowed sends the caller to the
    // source. `ALL` lives on the types, so this cannot drift from them.
    let mode = match patch.mode.as_deref() {
        Some(raw) => Some(CalendarMode::strict(raw).ok_or_else(|| {
            ApiError::message(
                StatusCode::BAD_REQUEST,
                format!(
                    "{raw} is not a mode — {}",
                    names(&CalendarMode::ALL.map(CalendarMode::as_str))
                ),
            )
        })?),
        None => None,
    };
    let region = match patch.region.as_deref() {
        Some(raw) => Some(HolidaySet::strict(raw).ok_or_else(|| {
            ApiError::message(
                StatusCode::BAD_REQUEST,
                format!(
                    "{raw} is not a region this build knows — {}. Mark the dates \
                     themselves with `days` for anywhere else",
                    names(&HolidaySet::ALL.map(HolidaySet::as_str))
                ),
            )
        })?),
        None => None,
    };

    let week = match &patch.week {
        Some(value) => {
            let values = value.as_array().ok_or_else(|| {
                ApiError::message(
                    StatusCode::BAD_REQUEST,
                    "week must be seven true/false values, Monday first",
                )
            })?;
            if values.len() != 7 {
                return Err(ApiError::message(
                    StatusCode::BAD_REQUEST,
                    format!("week must be 7 days starting Monday — got {}", values.len()),
                ));
            }
            let mut week = [false; 7];
            for (slot, value) in week.iter_mut().zip(values) {
                // Named rather than left to serde: `1`/`0` is how somebody
                // who has seen the stored `"1111100"` mask will write this,
                // and a refusal that says so beats one naming a Rust type.
                *slot = value.as_bool().ok_or_else(|| {
                    ApiError::message(
                        StatusCode::BAD_REQUEST,
                        format!(
                            "week takes true and false, not {value} — seven of them, Monday first"
                        ),
                    )
                })?;
            }
            if !week.contains(&true) {
                return Err(ApiError::message(
                    StatusCode::BAD_REQUEST,
                    "week must have at least one working day — with none, no task can be scheduled",
                ));
            }
            Some(week)
        }
        None => None,
    };

    // Parsed into store terms up front, so a typo in the last date of a
    // long list costs nothing.
    let mut marks: Vec<(NaiveDate, Option<DayMark>)> = Vec::new();
    let days = match &patch.days {
        Some(value) => value.as_object().ok_or_else(|| {
            ApiError::message(
                StatusCode::BAD_REQUEST,
                "days is a map of date to name, true, false or null",
            )
        })?,
        None => &serde_json::Map::new(),
    };
    for (day, value) in days {
        let date: NaiveDate = day.parse().map_err(|_| {
            ApiError::message(
                StatusCode::BAD_REQUEST,
                format!("{day} is not a date — days are keyed YYYY-MM-DD"),
            )
        })?;
        let mark = match value {
            serde_json::Value::String(name) => Some(DayMark::Holiday(name.clone())),
            serde_json::Value::Bool(true) => Some(DayMark::Holiday(String::new())),
            serde_json::Value::Bool(false) => Some(DayMark::Working),
            serde_json::Value::Null => None,
            other => {
                return Err(ApiError::message(
                    StatusCode::BAD_REQUEST,
                    format!("{day} must be a name, true, false or null — got {other}"),
                ));
            }
        };
        marks.push((date, mark));
    }

    let project = state.active();
    let response = {
        let mut store = lock(&project);
        if let Some(mode) = mode {
            store.set_calendar_mode(mode)?;
        }
        if let Some(week) = week {
            store.set_work_week(week)?;
        }
        if let Some(region) = region {
            store.set_holiday_set(region)?;
        }
        // Every named day in one pass under one lock, which is what makes
        // posting a whole year's holidays a single request rather than
        // fifty racing ones.
        for (date, mark) in marks {
            store.mark_day(date, mark)?;
        }
        respond(&store)
    };
    // Bumped, unlike `put_ui`: the calendar is in the CRDT log, so there
    // is something for the sync layer to push — and a peer left counting
    // in the old week would draw a different plan from the same tasks.
    project.notify.notify_one();
    response
}

/// The values a refusal should quote, as `a or b`.
///
/// Fed from the enums' own `ALL`, so a variant added tomorrow turns up in
/// the message without anybody remembering to come back here.
fn names(values: &[&str]) -> String {
    values.join(" or ")
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

/// Handler-level tests for the project endpoints.
///
/// Separate from the `AppState` unit tests above because the bugs these
/// catch live in the *handlers* — the order of a validation check against
/// an early return, a status code — and `AppState` never sees them. The
/// absence of this layer is how a `from == to` shortcut came to sit in
/// front of an existence check and turn a 404 into a 200.
#[cfg(test)]
mod handler_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn server(names: &[&str]) -> Router {
        let projects = names
            .iter()
            .map(|name| {
                OpenProject::new(
                    *name,
                    PathBuf::from(format!("{name}.db")),
                    Store::open_in_memory().unwrap(),
                )
            })
            .collect();
        // Never the real credentials file: `push_gcal` reads one and
        // then goes to the network, so a test sharing it with the
        // developer would make live Calendar API calls under their
        // account. The path deliberately does not exist.
        router(
            AppState::with_projects(projects, None)
                .with_credentials_path(server_credentials_path()),
        )
    }

    /// A credentials path of this process's own, which is never created.
    ///
    /// Not `YAIBA_DATA_DIR`: `set_var` is `unsafe` in edition 2024 and
    /// the environment is shared across the whole test binary, which is
    /// the hazard `seed_default` already documents.
    fn server_credentials_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "yaiba-test-credentials-{}.toml",
            std::process::id()
        ))
    }

    async fn send(
        app: Router,
        method: &str,
        uri: &str,
        body: Option<&str>,
    ) -> (StatusCode, String) {
        let request = Request::builder().method(method).uri(uri);
        let request = match body {
            Some(json) => request
                .header("content-type", "application/json")
                .body(Body::from(json.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    /// The regression: reordering `is_open` under the registry lock left
    /// the no-op shortcut in front of it, so renaming a project that was
    /// never open *to its own name* answered 200 instead of 404.
    #[tokio::test]
    async fn a_push_never_reads_the_credential_the_developer_is_logged_in_with() {
        // The hazard this guards is not a wrong assertion, it is a live
        // API call: `push_gcal` reads a token and then goes to the
        // network, and its in-memory store names no calendar — so a run
        // that got that far would create a stray `yaiba: work` calendar
        // in somebody's real Google account, from `cargo test`.
        let path = server_credentials_path();
        assert!(
            !path.exists(),
            "the test server must not point at a file anybody is using: {}",
            path.display()
        );
        assert_ne!(
            Some(path.as_path()),
            crate::credentials::default_path().ok().as_deref(),
            "the test server must not share the real credentials file"
        );
    }

    #[tokio::test]
    async fn pushing_before_there_is_anything_to_push_with_is_a_412() {
        // Two preconditions, both 412 and either can be the one that
        // fires: the client credentials come from the environment, and
        // this suite runs on developer machines where they may well be
        // set. What must never happen is a 500, or a push that reaches
        // the network with nothing to authenticate as.
        let (status, body) = send(server(&["work"]), "POST", "/api/gcal/push", None).await;
        assert_eq!(status, StatusCode::PRECONDITION_FAILED, "{body}");
        assert!(
            body.contains("YAIBA_GCAL_CLIENT_ID") || body.contains("yaiba gcal login"),
            "the refusal should name what to do about it: {body}"
        );
    }

    #[tokio::test]
    async fn renaming_a_project_that_is_not_open_to_itself_is_still_a_404() {
        let (status, body) = send(
            server(&["work"]),
            "PATCH",
            "/api/projects/ghost",
            Some(r#"{"to":"ghost"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }

    #[tokio::test]
    async fn renaming_an_open_project_to_itself_is_a_no_op() {
        let (status, body) = send(
            server(&["work"]),
            "PATCH",
            "/api/projects/work",
            Some(r#"{"to":"work"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#""active":"work""#), "{body}");
    }

    #[tokio::test]
    async fn renaming_onto_another_open_project_is_a_409() {
        let (status, body) = send(
            server(&["work", "personal"]),
            "PATCH",
            "/api/projects/work",
            Some(r#"{"to":"personal"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
    }

    #[tokio::test]
    async fn a_name_that_is_not_usable_as_a_file_is_a_400() {
        let (status, body) = send(
            server(&["work"]),
            "PATCH",
            "/api/projects/work",
            Some(r#"{"to":"a/b"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }

    /// A bad ticket has to be caught before anything is created, the way
    /// the CLI's `join` catches it: past this point there is a database
    /// on disk and a registry entry naming it, and the name is then taken
    /// by a project that never joined anybody.
    ///
    /// Reaching a 400 at all is the assertion — this server holds no
    /// registry lock and no data directory, so any answer other than a
    /// refusal means the handler went looking for one.
    #[tokio::test]
    async fn joining_with_a_malformed_ticket_creates_nothing() {
        let (status, body) = send(
            server(&["work"]),
            "POST",
            "/api/projects/join",
            Some(r#"{"ticket":"not-a-ticket"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }

    #[tokio::test]
    async fn switching_to_a_project_that_is_not_open_is_a_404() {
        let (status, body) = send(
            server(&["work"]),
            "POST",
            "/api/projects",
            Some(r#"{"name":"ghost"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }

    /// A server with nothing open has no answer for any endpoint, so the
    /// last project cannot be closed.
    #[tokio::test]
    async fn forgetting_the_only_open_project_is_a_409() {
        let (status, body) = send(server(&["work"]), "DELETE", "/api/projects/work", None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
    }

    #[tokio::test]
    async fn forgetting_a_project_that_is_not_open_is_a_404() {
        let (status, body) = send(
            server(&["work", "personal"]),
            "DELETE",
            "/api/projects/ghost",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }

    /// The UI state starts empty, survives a round-trip, and belongs to
    /// the project it was saved under — a switch serves the other
    /// project's blob, not this one's.
    #[tokio::test]
    async fn ui_state_is_per_project() {
        let app = server(&["work", "personal"]);
        let (status, body) = send(app.clone(), "GET", "/api/ui", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, "{}");

        let (status, body) = send(
            app.clone(),
            "PUT",
            "/api/ui",
            Some(r#"{"collapsed":["a"],"filter":"tag:dev"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let (status, body) = send(
            app.clone(),
            "POST",
            "/api/projects",
            Some(r#"{"name":"personal"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = send(app.clone(), "GET", "/api/ui", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, "{}", "{body}");

        let (status, body) = send(
            app.clone(),
            "POST",
            "/api/projects",
            Some(r#"{"name":"work"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = send(app, "GET", "/api/ui", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#""filter":"tag:dev""#), "{body}");
    }

    /// A server nobody has configured has to answer with today's
    /// behaviour, or the upgrade moves bars on its own.
    #[tokio::test]
    async fn the_state_starts_in_calendar_day_mode() {
        let (status, body) = send(server(&["work"]), "GET", "/api/state", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#""mode":"days""#), "{body}");
        assert!(body.contains(r#""region":"none""#), "{body}");
        assert!(
            body.contains(r#""week":[true,true,true,true,true,false,false]"#),
            "seven flags, Monday first: {body}"
        );
    }

    #[tokio::test]
    async fn the_calendar_round_trips_through_the_route() {
        // Dates relative to today, because the response only resolves a
        // window around it — a fixed 2026 in here would be a test that
        // starts failing in 2029 for no reason anybody could guess.
        let (saturday, tuesday) = a_saturday_and_a_weekday();
        let app = server(&["work"]);
        let (status, body) = send(
            app.clone(),
            "PUT",
            "/api/calendar",
            Some(&format!(
                r#"{{"mode":"workdays","week":[true,true,true,true,true,false,false],
                     "region":"jp","days":{{"{tuesday}":"創立記念日","{saturday}":false}}}}"#
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        // The write answers with the whole state, so this is also the
        // assertion that the resolution went out with it.
        assert!(body.contains(r#""mode":"workdays""#), "{body}");
        assert!(body.contains(r#""region":"jp""#), "{body}");
        assert!(
            body.contains(&format!(r#""{tuesday}":"創立記念日""#)),
            "{body}"
        );
        // A Saturday, so marking it worked really does override the week
        // mask — which is the only kind `workdays` carries. A Working mark
        // on a day the mask already works says nothing and is not sent.
        assert!(
            body.contains(&format!(r#""workdays":["{saturday}"]"#)),
            "{body}"
        );

        // Patch semantics: naming only `region` must leave the rest alone.
        let (status, body) = send(
            app.clone(),
            "PUT",
            "/api/calendar",
            Some(r#"{"region":"none"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#""mode":"workdays""#), "{body}");
        assert!(body.contains(r#""region":"none""#), "{body}");
        assert!(
            body.contains(&format!(r#""workdays":["{saturday}"]"#)),
            "{body}"
        );

        // `null` takes a mark away again. With no holiday table left on,
        // clearing both marks empties the resolution entirely.
        let (status, body) = send(
            app,
            "PUT",
            "/api/calendar",
            Some(&format!(
                r#"{{"days":{{"{tuesday}":null,"{saturday}":null}}}}"#
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#""holidays":{}"#), "{body}");
        assert!(body.contains(r#""workdays":[]"#), "{body}");
    }

    /// A Saturday in the coming week and the weekday three days after it,
    /// both comfortably inside the resolution window whenever the suite
    /// runs.
    fn a_saturday_and_a_weekday() -> (NaiveDate, NaiveDate) {
        use chrono::Datelike as _;
        let today = Local::now().date_naive();
        let saturday = (0..7)
            .filter_map(|n| today.checked_add_days(chrono::Days::new(n)))
            .find(|d| d.weekday() == chrono::Weekday::Sat)
            .expect("one of the next seven days is a Saturday");
        let tuesday = saturday
            .checked_add_days(chrono::Days::new(3))
            .expect("three days past a Saturday is in range");
        (saturday, tuesday)
    }

    /// The general escape hatch, and the reason the built-in tables are a
    /// shortcut rather than the mechanism: anywhere without a table of its
    /// own posts its own holidays, and has to be able to do it in *one*
    /// call rather than one per day.
    #[tokio::test]
    async fn a_whole_year_of_holidays_lands_in_one_request() {
        let start = Local::now().date_naive();
        let days: Vec<NaiveDate> = (0..24)
            .filter_map(|n| start.checked_add_days(chrono::Days::new(n * 14)))
            .collect();
        let payload = days
            .iter()
            .map(|day| format!(r#""{day}":"closed {day}""#))
            .collect::<Vec<_>>()
            .join(",");

        let (status, body) = send(
            server(&["work"]),
            "PUT",
            "/api/calendar",
            Some(&format!(r#"{{"days":{{{payload}}}}}"#)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        for day in &days {
            let expected = format!(r#""{day}":"closed {day}""#);
            assert!(body.contains(&expected), "{expected} missing from {body}");
        }
    }

    #[tokio::test]
    async fn a_week_that_is_not_seven_days_is_a_400() {
        let (status, body) = send(
            server(&["work"]),
            "PUT",
            "/api/calendar",
            Some(r#"{"week":[true,true,true,true,true]}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(
            body.contains("7 days"),
            "the refusal names the shape: {body}"
        );
    }

    /// The store degrades an all-`false` week to every day working, because
    /// it may have come from a peer. A person typing it has made a mistake,
    /// and this route is where that is said out loud.
    #[tokio::test]
    async fn a_week_with_no_working_days_is_a_400() {
        let (status, body) = send(
            server(&["work"]),
            "PUT",
            "/api/calendar",
            Some(r#"{"week":[false,false,false,false,false,false,false]}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(
            body.contains("at least one working day"),
            "the refusal says why: {body}"
        );
    }

    #[tokio::test]
    async fn a_day_that_is_not_a_date_is_a_400_and_writes_nothing() {
        let app = server(&["work"]);
        let (status, body) = send(
            app.clone(),
            "PUT",
            "/api/calendar",
            Some(r#"{"mode":"workdays","days":{"tomorrow":"創立記念日"}}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body.contains("YYYY-MM-DD"), "{body}");

        // The mode in the same body must not have landed: validation
        // happens before the first commit precisely so a refused patch
        // leaves the calendar as it was.
        let (status, body) = send(app, "GET", "/api/state", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#""mode":"days""#), "{body}");
    }
}
