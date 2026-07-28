//! Plain data types shared by the store, the scheduler and the HTTP API.
//!
//! Ids are UUIDs rather than autoincrementing integers: with every peer
//! writing to its own replica there is no central allocator, and v7
//! keeps ids roughly time-ordered so a fresh task still sorts sensibly
//! before its `position` is set.

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

pub type TaskId = Uuid;

/// Lifecycle of a single task.
///
/// `Blocked` is deliberately *not* a variant — being blocked is derived
/// from the dependency graph, so storing it would let the two disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Todo,
    Doing,
    Done,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Todo => "todo",
            Status::Doing => "doing",
            Status::Done => "done",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "doing" => Status::Doing,
            "done" => Status::Done,
            _ => Status::Todo,
        }
    }
}

/// A task, materialised from its CRDT entries.
///
/// `updated_at` and `done_at` are *derived* from the entry timestamps
/// rather than stored, so they can never drift from the data they
/// describe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: TaskId,
    /// Enclosing task, forming the work breakdown. `None` makes this a
    /// root — which is what a "project" is here.
    ///
    /// Orthogonal to dependencies: a parent *contains* its children,
    /// while a dependency *orders* two tasks. A task can have both.
    #[serde(default)]
    pub parent: Option<TaskId>,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub status: Status,
    /// 0 = none, 1 = low, 2 = mid, 3 = high. Rendered as the vim-ish
    /// `A` / `B` / `C` markers in the UI.
    #[serde(default)]
    pub priority: i64,
    /// Hard-pinned start. `None` lets the scheduler place the task as
    /// early as its dependencies allow.
    #[serde(default)]
    pub start: Option<NaiveDate>,
    /// Calendar days the bar spans; always >= 1.
    pub duration_days: i64,
    #[serde(default)]
    pub due: Option<NaiveDate>,
    /// When work actually began. Set automatically the first time the
    /// task moves off `todo`, and editable afterwards — the plan is
    /// what you intend, this is what happened.
    #[serde(default)]
    pub actual_start: Option<NaiveDate>,
    /// When work actually finished. Set automatically on `done`.
    #[serde(default)]
    pub actual_end: Option<NaiveDate>,
    /// 0..=100.
    #[serde(default)]
    pub progress: i64,
    /// Manual ordering key for the list view.
    pub position: f64,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub done_at: Option<DateTime<Utc>>,
}

/// Payload for `POST /api/tasks`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct NewTask {
    #[serde(default)]
    pub parent: Option<TaskId>,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub status: Status,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub start: Option<NaiveDate>,
    #[serde(default)]
    pub duration_days: Option<i64>,
    #[serde(default)]
    pub due: Option<NaiveDate>,
    #[serde(default)]
    pub actual_start: Option<NaiveDate>,
    #[serde(default)]
    pub actual_end: Option<NaiveDate>,
    #[serde(default)]
    pub progress: i64,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Insert directly after this task in the manual ordering. `None`
    /// appends to the end.
    #[serde(default)]
    pub after: Option<TaskId>,
    /// Insert directly *before* this task instead, which is what `O`
    /// means. Without it the topmost row has nothing to anchor to and
    /// the new task is appended to the end of the store — the opposite
    /// of "above this one". Takes precedence over `after` when both are
    /// set; `None` leaves the placement to `after`.
    #[serde(default)]
    pub before: Option<TaskId>,
}

/// Partial update for `PATCH /api/tasks/:id`.
///
/// Nullable fields use `Option<Option<T>>` so that an omitted key and an
/// explicit `null` mean different things: leave alone vs. clear.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TaskPatch {
    #[serde(default, deserialize_with = "double_option")]
    pub parent: Option<Option<TaskId>>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub status: Option<Status>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    pub start: Option<Option<NaiveDate>>,
    #[serde(default)]
    pub duration_days: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    pub due: Option<Option<NaiveDate>>,
    #[serde(default, deserialize_with = "double_option")]
    pub actual_start: Option<Option<NaiveDate>>,
    #[serde(default, deserialize_with = "double_option")]
    pub actual_end: Option<Option<NaiveDate>>,
    #[serde(default)]
    pub progress: Option<i64>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

/// Distinguishes "key absent" (`None`) from "key present and null"
/// (`Some(None)`) during deserialisation.
fn double_option<'de, T, D>(de: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

/// A finish-to-start edge: `from` must finish before `to` may start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Dep {
    pub from: TaskId,
    pub to: TaskId,
}

/// The materialised dataset — live tasks (tombstones excluded) and edges.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub tasks: Vec<Task>,
    pub deps: Vec<Dep>,
}
