//! Domain model, replicated persistence and scheduling for `yaiba`.
//!
//! The data model is a CRDT: every peer runs its own replica and writes
//! locally, and syncing is a commutative merge rather than a
//! client-to-server round trip. There is no authoritative copy, which is
//! the point — `yaiba` peers talk to each other, not to a server someone
//! has to keep running.
//!
//! The crate is deliberately synchronous: the whole dataset fits in
//! memory, so a plain `rusqlite::Connection` behind a mutex beats
//! dragging an async SQL runtime in. The server crate owns the mutex.

pub mod crdt;
pub mod graph;
pub mod hlc;
pub mod model;
pub mod store;

pub use crdt::{Entry, VersionVector};
pub use graph::{Schedule, Scheduled, schedule};
pub use hlc::{Clock, Hlc, NodeId};
pub use model::{Dep, NewTask, Snapshot, Status, Task, TaskId, TaskPatch};
pub use store::Store;

/// Errors surfaced to the HTTP layer.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("task {0} not found")]
    NotFound(TaskId),
    #[error("dependency {from} -> {to} would create a cycle")]
    Cycle { from: TaskId, to: TaskId },
    #[error("a task cannot depend on itself")]
    SelfDep,
    #[error("that would put a task inside itself")]
    ParentCycle,
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
