//! An MCP server, so an agent can read and edit the plan.
//!
//! `yaiba mcp` speaks the Model Context Protocol over stdio — the shape
//! `claude mcp add yaiba -- yaiba mcp` launches. It is part of the one
//! binary rather than a package of its own because that is the whole of
//! the install story, and because it then rides the existing release: a
//! separate npm or cargo artifact would be a second thing to version and
//! a second thing to forget to publish.
//!
//! **It reaches yaiba through the HTTP API, not the database.** Opening
//! `yaiba.db` here would make this a second writer, and the project note
//! in AGENTS.md — one process holds every project — is what keeps the
//! CRDT log and the sync room key consistent. Going through the API also
//! means every refusal the server already knows how to make is made once:
//! a dependency cycle is a 409 here exactly as it is in the UI, a
//! summary's dates are still refused, and an agent cannot invent a state
//! the app would not let a person type.
//!
//! The cost is that yaiba has to be running. That is the honest failure
//! and it is reported as one — starting a server from in here would mean
//! guessing a port and a project, and a wrong guess is an agent quietly
//! editing the wrong plan.
//!
//! ## Nothing may be written to stdout
//!
//! stdout **is** the protocol. `main` initialises tracing on stdout for
//! every other subcommand; for this one it must go to stderr, or the
//! first log line is a parse error on the client. That branch is in
//! `main.rs` and is load-bearing — see the comment there.

use std::fmt::Write as _;

use anyhow::{Context, Result};
use chrono::NaiveDate;
use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{Implementation, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router,
    transport::stdio,
};
use serde::Deserialize;
use serde_json::json;
use yaiba_core::{Dep, Schedule, Task};

/// Where the running yaiba is. Loopback only — the API has no
/// authentication, which is exactly why it is not addressable off-box.
const DEFAULT_BASE: &str = "http://127.0.0.1:8188";

/// The state the plan is read out of.
///
/// A reader's view of `api::StateResponse`, not that type itself — its
/// fields are private to the `api` module, and serde ignores what is not
/// named here, so this stays valid as the response grows. The three
/// fields below are the ones an agent has any use for.
#[derive(Debug, Deserialize)]
struct State {
    tasks: Vec<Task>,
    deps: Vec<Dep>,
    schedule: Schedule,
    today: NaiveDate,
}

#[derive(Debug, Deserialize)]
struct Projects {
    projects: Vec<Project>,
    active: String,
}

#[derive(Debug, Deserialize)]
struct Project {
    name: String,
}

/// The MCP server: a client for one yaiba, and nothing else.
#[derive(Clone)]
pub struct Yaiba {
    base: String,
    http: reqwest::Client,
    tool_router: ToolRouter<Yaiba>,
}

/// How long any one call to yaiba may take.
///
/// The server is on loopback and answers in milliseconds, so this is not
/// a latency budget — it is a guarantee of *termination*. reqwest applies
/// no default timeout, and an MCP tool call has no clock of its own: a
/// yaiba wedged mid-request would hang the agent's turn with no error and
/// nothing to cancel.
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl Yaiba {
    pub fn new(base: String) -> Self {
        Self {
            base,
            http: reqwest::Client::builder()
                .timeout(CALL_TIMEOUT)
                .build()
                // Only fails when a TLS backend can't be initialised, and
                // this build has none to initialise.
                .unwrap_or_default(),
            tool_router: Self::tool_router(),
        }
    }

    async fn state(&self) -> Result<State, String> {
        self.send(self.http.get(format!("{}/api/state", self.base)))
            .await
    }

    /// Send a write and say where the plan stands afterwards.
    ///
    /// **It reports state, not a delta, and that is deliberate.** Saying
    /// "the finish moved a week earlier" would be the more useful
    /// sentence, and the first version of this did exactly that by
    /// reading the state either side of the write. It lies: the two reads
    /// and the write are three separate requests, so anything else
    /// editing in between — a second tool call the client issued in
    /// parallel, or a person typing in the UI — lands inside the window
    /// and gets attributed to this edit. Driving four writes at once, all
    /// four claimed the same change. A number that is only true when
    /// nothing else is happening is worse than no number.
    ///
    /// The API's reply is the whole new state, so this needs no extra
    /// round trip to say what is true now.
    async fn write(&self, req: reqwest::RequestBuilder, did: &str) -> String {
        match self.send(req).await {
            Ok(state) => format!("{did}. {}", standing(&state)),
            Err(e) => e,
        }
    }

    /// Make one call and decode what it answered with.
    ///
    /// Every request goes through here, reads included, so the status is
    /// checked in exactly one place. It used to be writes only, and a
    /// `GET /api/state` that answered 500 was reported as "yaiba is not
    /// running" — the one diagnosis that sends you to restart a server
    /// that is already up.
    async fn send<T: serde::de::DeserializeOwned>(
        &self,
        req: reqwest::RequestBuilder,
    ) -> Result<T, String> {
        let response = req
            .send()
            .await
            .map_err(|e| format!("could not reach yaiba on {}: {e}", self.base))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            // The server's own refusals arrive here — a cycle is a 409, a
            // summary's dates a 400. They are the message worth relaying:
            // they say why the edit was wrong, which a generic failure
            // would not.
            return Err(format!("yaiba refused: {status} {}", body.trim()));
        }
        response
            .json::<T>()
            .await
            .map_err(|e| format!("could not read yaiba's reply: {e}"))
    }

    /// Resolve what the agent called a task into the id the API takes.
    ///
    /// Agents are given the short id in `plan` and will mostly hand one
    /// back, but they also refer to a row by its title, and a UUID typed
    /// from memory is a UUID typed wrong. So, in order: the whole id, the
    /// short id `plan` prints, an id prefix, an exact title, then a unique
    /// substring of one. An ambiguous needle is an error naming the
    /// candidates rather than a guess — picking one would edit a task
    /// nobody chose.
    fn resolve(state: &State, needle: &str) -> Result<String, String> {
        // Rejected before matching, because an empty needle is not a
        // no-op: `starts_with("")` and `contains("")` are true of every
        // task, so on a one-task plan it would resolve — and then edit a
        // row nobody named.
        if needle.trim().is_empty() {
            return Err("name a task — its title, or the short id `plan` prints".to_string());
        }
        let needle_lower = needle.to_lowercase();
        let by = |f: &dyn Fn(&Task) -> bool| -> Vec<&Task> {
            state.tasks.iter().filter(|t| f(t)).collect()
        };

        for candidates in [
            by(&|t| t.id.to_string() == needle),
            by(&|t| short(&t.id.to_string()) == needle),
            by(&|t| t.id.to_string().starts_with(needle)),
            by(&|t| t.title.to_lowercase() == needle_lower),
            by(&|t| t.title.to_lowercase().contains(&needle_lower)),
        ] {
            match candidates.len() {
                0 => continue,
                1 => return Ok(candidates[0].id.to_string()),
                _ => {
                    let names: Vec<String> = candidates
                        .iter()
                        .take(5)
                        .map(|t| format!("{} ({})", t.title, short(&t.id.to_string())))
                        .collect();
                    return Err(format!(
                        "\"{needle}\" matches {} tasks: {}. Name one exactly, or use its id.",
                        candidates.len(),
                        names.join(", ")
                    ));
                }
            }
        }
        Err(format!("no task matches \"{needle}\""))
    }
}

/// The *last* segment of a UUID — short enough for an agent to copy back,
/// and actually distinct.
///
/// Not the first segment, which is the obvious choice and is wrong here:
/// task ids are UUIDv7 and their leading bits are a timestamp, so every
/// row created in the same millisecond shares a prefix. Three tasks
/// seeded in one loop all rendered as `019fcc35`, which is not a name.
/// The trailing segment is the random half. `resolve` matches on it.
fn short(id: &str) -> &str {
    id.rsplit('-').next().unwrap_or(id)
}

/// Where the plan stands, in the terms it is judged by.
///
/// An agent that just edited something wants to know whether the edit
/// mattered, and the answer is almost never in the task it touched — it
/// is in the finish date and the critical path. Those are the three
/// numbers worth carrying back after every write, and unlike a delta they
/// are true no matter what else is editing at the same time. Comparing
/// against the previous call's answer is the caller's to do, and only the
/// caller knows whether anything else ran in between.
fn standing(state: &State) -> String {
    let overdue = state.schedule.tasks.iter().filter(|t| t.overdue).count();
    let mut out = format!(
        "The plan now ends {}, with {} on the critical path",
        state.schedule.end,
        state.schedule.critical_path.len()
    );
    if overdue > 0 {
        let _ = write!(out, " and {overdue} overdue");
    }
    out.push('.');
    out
}

// ---- tool arguments -------------------------------------------------
//
// One struct per tool. `schemars` turns each into the JSON Schema the
// client sees, so the description an agent reads and the field the tool
// actually uses cannot drift apart.

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AddTask {
    #[schemars(description = "What the task is called.")]
    pub title: String,
    #[schemars(
        description = "Enclosing task — id, id prefix, or title. A task with children takes its dates from them, so put work on the leaves."
    )]
    pub parent: Option<String>,
    #[schemars(description = "Calendar days the task spans. Defaults to 1.")]
    pub duration_days: Option<i64>,
    #[schemars(description = "Who it belongs to. Free text; use a name already in the plan.")]
    pub assignee: Option<String>,
    #[schemars(description = "Due date, YYYY-MM-DD. A finish after this marks the task overdue.")]
    pub due: Option<String>,
    #[schemars(
        description = "Task this one must wait for — id, id prefix, or title. Adds the dependency in the same call."
    )]
    pub after_task: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateTask {
    #[schemars(description = "Which task — id, id prefix, or title.")]
    pub task: String,
    #[schemars(description = "New title.")]
    pub title: Option<String>,
    #[schemars(description = "todo, doing, or done.")]
    pub status: Option<String>,
    #[schemars(description = "Who it belongs to.")]
    pub assignee: Option<String>,
    #[schemars(description = "Percent complete, 0 to 100.")]
    pub progress: Option<i64>,
    #[schemars(
        description = "Pinned start, YYYY-MM-DD. A pin is a floor: the task starts no earlier, and it cannot be pulled before a predecessor finishes."
    )]
    pub start: Option<String>,
    #[schemars(description = "Calendar days the task spans.")]
    pub duration_days: Option<i64>,
    #[schemars(description = "Due date, YYYY-MM-DD.")]
    pub due: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct OneTask {
    #[schemars(description = "Which task — id, id prefix, or title.")]
    pub task: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct Edge {
    #[schemars(description = "The task that must finish first — id, id prefix, or title.")]
    pub from: String,
    #[schemars(description = "The task that waits — id, id prefix, or title.")]
    pub to: String,
    #[schemars(
        description = "Calendar days between the first finishing and the second starting. 1 means the next day, 0 lets them share a date. Ignored when cutting."
    )]
    pub lag_days: Option<i64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PickProject {
    #[schemars(description = "Project name, as `projects` lists it.")]
    pub name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct NoArgs {}

// ---- the tools ------------------------------------------------------

#[tool_router]
impl Yaiba {
    #[tool(
        description = "Read the whole plan: every task with its computed start and finish, who owns it, what is on the critical path, what is blocked, what is behind (its finish has passed and it is still open), and what is overdue (its finish lands after a due date somebody set). The dates are the scheduler's, not stored values — a task with children takes its span from them."
    )]
    async fn plan(&self, Parameters(NoArgs {}): Parameters<NoArgs>) -> String {
        let state = match self.state().await {
            Ok(state) => state,
            Err(e) => return format!("{e:#}"),
        };
        render_plan(&state)
    }

    #[tool(
        description = "Add a task. Optionally nest it under a parent, give it a duration, an owner, a due date, and a dependency in the same call."
    )]
    async fn add_task(&self, Parameters(args): Parameters<AddTask>) -> String {
        let state = match self.state().await {
            Ok(state) => state,
            Err(e) => return format!("{e:#}"),
        };

        let parent = match args.parent.as_deref().map(|p| Self::resolve(&state, p)) {
            Some(Err(e)) => return e,
            Some(Ok(id)) => Some(id),
            None => None,
        };
        let wait_for = match args.after_task.as_deref().map(|p| Self::resolve(&state, p)) {
            Some(Err(e)) => return e,
            Some(Ok(id)) => Some(id),
            None => None,
        };

        let mut body = json!({ "title": args.title });
        if let Some(parent) = parent {
            body["parent"] = json!(parent);
        }
        if let Some(days) = args.duration_days {
            body["duration_days"] = json!(days);
        }
        if let Some(assignee) = args.assignee {
            body["assignee"] = json!(assignee);
        }
        if let Some(due) = args.due {
            body["due"] = json!(due);
        }

        let after = match self
            .send(
                self.http
                    .post(format!("{}/api/tasks", self.base))
                    .json(&body),
            )
            .await
        {
            Ok(after) => after,
            Err(e) => return e,
        };

        let Some(wait_for) = wait_for else {
            return format!("Added \"{}\". {}", args.title, standing(&after));
        };

        // The edge needs the new task's id, and the create's reply is the
        // whole state rather than the row — so the new task is the one
        // that was not there before. By id, not by title: adding a second
        // task with an existing name is a thing people do, and matching
        // on the name would link the wrong one.
        //
        // There is a window between the read at the top of this function
        // and the create above, and anything else writing inside it — a
        // parallel tool call, a person in the UI — also shows up as new.
        // So more than one candidate is *refused* rather than guessed at,
        // the same rule `resolve` follows: picking whichever iterated
        // first would attach the dependency to a row nobody asked about,
        // and unlike a wrong sentence a wrong edge changes the schedule.
        let fresh: Vec<&Task> = after
            .tasks
            .iter()
            .filter(|t| !state.tasks.iter().any(|old| old.id == t.id))
            .collect();
        let new_id = match fresh.as_slice() {
            [task] => task.id.to_string(),
            [] => {
                return format!(
                    "Added \"{}\", but could not tell which row is new, so it was not linked. {}",
                    args.title,
                    standing(&after)
                );
            }
            _ => {
                return format!(
                    "Added \"{}\", but {} tasks appeared while it was being created, so it is \
                     not clear which one is yours and nothing was linked. Link it with `link` \
                     once you can name it. {}",
                    args.title,
                    fresh.len(),
                    standing(&after)
                );
            }
        };

        match self
            .send(
                self.http
                    .post(format!("{}/api/deps", self.base))
                    .json(&json!({ "from": wait_for, "to": new_id, "lag_days": 1 })),
            )
            .await
        {
            Ok(linked) => format!(
                "Added \"{}\" and made it wait for \"{}\". {}",
                args.title,
                args.after_task.as_deref().unwrap_or(""),
                standing(&linked)
            ),
            // The task exists either way — say so, or the caller retries
            // the add and ends up with two.
            Err(e) => format!("Added \"{}\", but the link failed: {e}", args.title),
        }
    }

    #[tool(
        description = "Change a task: its title, status, owner, progress, pinned start, duration, or due date. Only the fields you pass are touched."
    )]
    async fn update_task(&self, Parameters(args): Parameters<UpdateTask>) -> String {
        let state = match self.state().await {
            Ok(state) => state,
            Err(e) => return format!("{e:#}"),
        };
        let id = match Self::resolve(&state, &args.task) {
            Ok(id) => id,
            Err(e) => return e,
        };

        let mut body = json!({});
        if let Some(title) = args.title {
            body["title"] = json!(title);
        }
        if let Some(status) = args.status {
            let status = status.to_lowercase();
            if !["todo", "doing", "done"].contains(&status.as_str()) {
                return format!("status must be todo, doing, or done — got \"{status}\"");
            }
            // Completing is also a progress change; leaving progress alone
            // would show a done task at 40%, which reads as unfinished.
            if status == "done" {
                body["progress"] = json!(100);
            }
            body["status"] = json!(status);
        }
        if let Some(assignee) = args.assignee {
            body["assignee"] = json!(assignee);
        }
        if let Some(progress) = args.progress {
            body["progress"] = json!(progress.clamp(0, 100));
        }
        if let Some(start) = args.start {
            body["start"] = json!(start);
        }
        if let Some(days) = args.duration_days {
            body["duration_days"] = json!(days);
        }
        if let Some(due) = args.due {
            body["due"] = json!(due);
        }
        if body.as_object().is_none_or(|o| o.is_empty()) {
            return "nothing to change — pass at least one field".to_string();
        }

        let title = state
            .tasks
            .iter()
            .find(|t| t.id.to_string() == id)
            .map(|t| t.title.clone())
            .unwrap_or_else(|| id.clone());
        self.write(
            self.http
                .patch(format!("{}/api/tasks/{id}", self.base))
                .json(&body),
            &format!("Updated \"{title}\""),
        )
        .await
    }

    #[tool(
        description = "Delete a task. Its dependencies go with it. This is not undoable from here."
    )]
    async fn delete_task(&self, Parameters(args): Parameters<OneTask>) -> String {
        let state = match self.state().await {
            Ok(state) => state,
            Err(e) => return format!("{e:#}"),
        };
        let id = match Self::resolve(&state, &args.task) {
            Ok(id) => id,
            Err(e) => return e,
        };
        let title = state
            .tasks
            .iter()
            .find(|t| t.id.to_string() == id)
            .map(|t| t.title.clone())
            .unwrap_or_else(|| id.clone());

        self.write(
            self.http.delete(format!("{}/api/tasks/{id}", self.base)),
            &format!("Deleted \"{title}\""),
        )
        .await
    }

    #[tool(
        description = "Make one task wait for another to finish. Refused if it would close a loop — including through a parent, since an edge touching a summary is expanded to its leaves."
    )]
    async fn link(&self, Parameters(args): Parameters<Edge>) -> String {
        let state = match self.state().await {
            Ok(state) => state,
            Err(e) => return format!("{e:#}"),
        };
        let (from, to) = match (
            Self::resolve(&state, &args.from),
            Self::resolve(&state, &args.to),
        ) {
            (Ok(from), Ok(to)) => (from, to),
            (Err(e), _) | (_, Err(e)) => return e,
        };

        self.write(
            self.http
                .post(format!("{}/api/deps", self.base))
                .json(&json!({
                    "from": from,
                    "to": to,
                    "lag_days": args.lag_days.unwrap_or(1).max(0),
                })),
            "Linked",
        )
        .await
    }

    #[tool(
        description = "Cut the dependency between two tasks. Whatever was waiting on it moves up."
    )]
    async fn unlink(&self, Parameters(args): Parameters<Edge>) -> String {
        let state = match self.state().await {
            Ok(state) => state,
            Err(e) => return format!("{e:#}"),
        };
        let (from, to) = match (
            Self::resolve(&state, &args.from),
            Self::resolve(&state, &args.to),
        ) {
            (Ok(from), Ok(to)) => (from, to),
            (Err(e), _) | (_, Err(e)) => return e,
        };
        if !state
            .deps
            .iter()
            .any(|d| d.from.to_string() == from && d.to.to_string() == to)
        {
            return "those two are not linked".to_string();
        }

        self.write(
            self.http
                .delete(format!("{}/api/deps/{from}/{to}", self.base)),
            "Cut the dependency",
        )
        .await
    }

    #[tool(
        description = "List the projects this yaiba holds and say which one is active. Every other tool reads and writes the active project."
    )]
    async fn projects(&self, Parameters(NoArgs {}): Parameters<NoArgs>) -> String {
        let projects: Projects = match self
            .send(self.http.get(format!("{}/api/projects", self.base)))
            .await
        {
            Ok(projects) => projects,
            Err(e) => return e,
        };

        let mut out = String::new();
        for project in &projects.projects {
            let mark = if project.name == projects.active {
                "*"
            } else {
                " "
            };
            let _ = writeln!(out, "{mark} {}", project.name);
        }
        out
    }

    #[tool(
        description = "Switch which project is active. Projects are separate databases — nothing is shared between them."
    )]
    async fn switch_project(&self, Parameters(args): Parameters<PickProject>) -> String {
        // Answers with the project list rather than the plan, so it is
        // decoded as one — the state is a different project's now.
        match self
            .send::<Projects>(
                self.http
                    .post(format!("{}/api/projects", self.base))
                    .json(&json!({ "name": args.name })),
            )
            .await
        {
            Ok(projects) => format!(
                "Switched to \"{}\". Every other tool now reads and writes that project.",
                projects.active
            ),
            Err(e) => e,
        }
    }
}

/// What the client is told about this server before it asks anything.
///
/// `instructions` is the one place to put the handful of rules that make
/// the difference between an agent that edits this plan well and one that
/// fights it. They are all things the API enforces anyway — the point is
/// that hearing them up front costs one paragraph, while discovering them
/// costs a refused call each.
#[tool_handler(router = self.tool_router)]
impl ServerHandler for Yaiba {
    fn get_info(&self) -> ServerInfo {
        // Built by mutation rather than a struct literal: `Implementation`
        // is `#[non_exhaustive]`, so `..` update syntax on it does not
        // compile outside the SDK.
        let mut me = Implementation::from_build_env();
        me.name = "yaiba".to_string();
        me.version = env!("CARGO_PKG_VERSION").to_string();

        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            // Names this "yaiba" rather than "rmcp". `from_build_env()`
            // is the documented way to fill this in and is wrong on its
            // own here: it reads the `CARGO_PKG_*` of the crate it is
            // compiled in, which is the SDK, so the client showed the
            // user "rmcp 3.1.0". The `env!` above expands in *this* crate.
            .with_server_info(me)
            .with_instructions(
                "yaiba is a dependency-scheduled plan: you enter durations and \
                 dependencies, and it computes the dates. Read `plan` before \
                 editing — it prints each task's short id, which every other \
                 tool accepts (a title works too, if it is unambiguous).\n\n\
                 Three rules the scheduler will enforce whether or not you know \
                 them:\n\
                 - A task with children takes its dates from them. Put work on \
                   the leaves; setting a parent's dates is refused.\n\
                 - Dependencies may not form a loop, including through a \
                   parent — an edge touching a summary is expanded to its \
                   leaves, so linking a task to its own parent is a cycle.\n\
                 - A pinned start is a floor, not an override: a task never \
                   starts before what it waits for has finished.\n\n\
                 Every write answers with where the plan then stands — its \
                 finish date and critical path. That is the measure of whether \
                 an edit mattered; the task you touched usually is not.",
            )
    }
}

/// The plan as an agent should read it.
///
/// Deliberately not the raw JSON. The API answers with every field of
/// every task plus the whole schedule; most of it is noise to a reader
/// asking what is late, and the parts that matter — critical, blocked,
/// overdue — are booleans that mean nothing without their names attached.
fn render_plan(state: &State) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{} tasks, {} dependencies. Today is {}; the plan runs {} → {}.",
        state.tasks.len(),
        state.deps.len(),
        state.today,
        state.schedule.start,
        state.schedule.end
    );

    let overdue = state.schedule.tasks.iter().filter(|t| t.overdue).count();
    let blocked = state.schedule.tasks.iter().filter(|t| t.blocked).count();
    // Leaves only, because `late` rolls up: a summary carries it from its
    // children, and counting both would report one overrun once for every
    // ancestor standing over it. The per-row marks below deliberately do
    // keep it on the summary — that is what makes a branch say so.
    let late = state
        .schedule
        .tasks
        .iter()
        .filter(|t| t.late && !t.summary)
        .count();
    let _ = writeln!(
        out,
        "{} on the critical path, {late} behind, {overdue} overdue, {blocked} blocked.\n",
        state.schedule.critical_path.len()
    );

    for task in &state.tasks {
        let Some(sched) = state
            .schedule
            .tasks
            .iter()
            .find(|s| s.id.to_string() == task.id.to_string())
        else {
            continue;
        };

        // The markers are the reason this is rendered rather than dumped:
        // each one is a word instead of a boolean nobody asked about.
        let mut marks = Vec::new();
        if sched.critical {
            marks.push("critical");
        }
        if sched.blocked {
            marks.push("blocked");
        }
        if sched.overdue {
            marks.push("overdue");
        }
        // Distinct from `overdue` and worth both words: that one means
        // the plan overruns a date somebody promised, this one means the
        // work is behind now. A reader asking "what has slipped" wants
        // this one, and until it existed the answer was not in here.
        if sched.late {
            marks.push("behind");
        }
        if sched.summary {
            marks.push("summary");
        }

        let indent = "  ".repeat(sched.level.max(0) as usize);
        let owner = if task.assignee.is_empty() {
            String::new()
        } else {
            format!(" @{}", task.assignee)
        };
        let marks = if marks.is_empty() {
            String::new()
        } else {
            format!("  [{}]", marks.join(", "))
        };

        let _ = writeln!(
            out,
            "{indent}[{}] {}{owner}  {} → {}  {}%{marks}  ({})",
            match format!("{:?}", task.status).to_lowercase().as_str() {
                "done" => "x",
                "doing" => "~",
                _ => " ",
            },
            task.title,
            sched.start,
            sched.end,
            sched.progress,
            short(&task.id.to_string()),
        );
    }
    out
}

/// Serve MCP on stdio until the client goes away.
pub async fn serve(base: Option<String>) -> Result<()> {
    // An empty `--url`, or `YAIBA_MCP_URL=`, is the default rather than a
    // base of "" — clap hands an env var through whatever it holds, and
    // an empty base fails later as a malformed request instead of here.
    let base = base
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE.to_string());

    // reqwest is built without a TLS backend — the only host this dials
    // is loopback — so an `https://` base fails inside reqwest and the
    // context below would blame it on yaiba not running, which is the
    // wrong thing to go and check.
    if !base.starts_with("http://") {
        anyhow::bail!(
            "--url must be http:// — got {base}. This talks to a yaiba on your own machine, \
             and is built without TLS."
        );
    }

    let yaiba = Yaiba::new(base.clone());

    // Fail here rather than on the agent's first question. A client that
    // connects to a server whose backing yaiba is down gets a tool list
    // that works and answers that never do.
    yaiba
        .state()
        .await
        .map_err(anyhow::Error::msg)
        .with_context(|| {
            format!("yaiba must be running on {base} before `yaiba mcp` can serve it")
        })?;

    tracing::info!("MCP server on stdio, talking to {base}");
    let service = yaiba.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;
    use yaiba_core::Schedule;

    use super::*;

    /// A task with a chosen id and title; every other field is whatever
    /// keeps the type happy. Nothing under test reads them.
    fn task(id: &str, title: &str) -> Task {
        Task {
            id: Uuid::parse_str(id).expect("test ids are valid uuids"),
            parent: None,
            title: title.to_string(),
            notes: String::new(),
            assignee: String::new(),
            status: Default::default(),
            priority: 0,
            start: None,
            duration_days: 1,
            due: None,
            actual_start: None,
            actual_end: None,
            progress: 0,
            position: 0.0,
            tags: Vec::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            done_at: None,
        }
    }

    fn state(tasks: Vec<Task>) -> State {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 8, 4).unwrap();
        State {
            tasks,
            deps: Vec::new(),
            schedule: Schedule {
                tasks: Vec::new(),
                start: today,
                end: today,
                critical_path: Vec::new(),
            },
            today,
        }
    }

    /// The bug this function was rewritten for: ids are UUIDv7, so rows
    /// created in the same millisecond share a *leading* segment. A short
    /// id that cannot tell two tasks apart is not a name — and `resolve`
    /// tells the caller to use one.
    #[test]
    fn short_id_distinguishes_tasks_created_together() {
        let a = "019fcc35-aacb-7300-bb59-dbe6f7e323a4";
        let b = "019fcc35-aacb-7301-9c2a-79e7fa68fea9";
        assert_ne!(short(a), short(b));
        assert_eq!(short(a), "dbe6f7e323a4");
    }

    #[test]
    fn resolves_by_whole_id_short_id_and_prefix() {
        let id = "019fcc35-aacb-7300-bb59-dbe6f7e323a4";
        let state = state(vec![task(id, "write the server")]);

        assert_eq!(Yaiba::resolve(&state, id).unwrap(), id);
        assert_eq!(Yaiba::resolve(&state, "dbe6f7e323a4").unwrap(), id);
        assert_eq!(Yaiba::resolve(&state, "019fcc35-aacb").unwrap(), id);
    }

    #[test]
    fn resolves_by_title_exactly_and_by_substring() {
        let id = "019fcc35-aacb-7300-bb59-dbe6f7e323a4";
        let state = state(vec![
            task(id, "write the server"),
            task("019fcc35-aacb-7301-9c2a-79e7fa68fea9", "ship it"),
        ]);

        assert_eq!(Yaiba::resolve(&state, "write the server").unwrap(), id);
        assert_eq!(Yaiba::resolve(&state, "WRITE THE SERVER").unwrap(), id);
        assert_eq!(Yaiba::resolve(&state, "server").unwrap(), id);
    }

    /// An exact title wins over a substring of a different one, so a task
    /// whose whole name appears inside another's is still reachable.
    #[test]
    fn an_exact_title_beats_a_substring_of_another() {
        let short_id = "019fcc35-aacb-7300-bb59-dbe6f7e323a4";
        let state = state(vec![
            task(short_id, "review"),
            task("019fcc35-aacb-7301-9c2a-79e7fa68fea9", "review the review"),
        ]);

        assert_eq!(Yaiba::resolve(&state, "review").unwrap(), short_id);
    }

    #[test]
    fn ambiguity_is_refused_and_names_the_candidates() {
        let state = state(vec![
            task("019fcc35-aacb-7300-bb59-dbe6f7e323a4", "design the api"),
            task("019fcc35-aacb-7301-9c2a-79e7fa68fea9", "write the server"),
        ]);

        let err = Yaiba::resolve(&state, "the").unwrap_err();
        assert!(err.contains("design the api"), "{err}");
        assert!(err.contains("write the server"), "{err}");
    }

    /// `starts_with("")` and `contains("")` are true of every task, so
    /// without this an empty argument would resolve on a one-task plan
    /// and edit a row nobody named.
    #[test]
    fn an_empty_needle_never_resolves() {
        let state = state(vec![task(
            "019fcc35-aacb-7300-bb59-dbe6f7e323a4",
            "the only task",
        )]);

        assert!(Yaiba::resolve(&state, "").is_err());
        assert!(Yaiba::resolve(&state, "   ").is_err());
    }

    #[test]
    fn no_match_says_so() {
        let state = state(vec![task(
            "019fcc35-aacb-7300-bb59-dbe6f7e323a4",
            "write the server",
        )]);

        let err = Yaiba::resolve(&state, "nothing like this").unwrap_err();
        assert!(err.contains("no task matches"), "{err}");
    }
}
