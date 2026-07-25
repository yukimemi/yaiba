//! The replicated data model: a last-writer-wins map keyed by
//! `(entity, field)`.
//!
//! Everything a user can change is one entry in this map, so merging two
//! replicas is a per-entry `max` on the HLC. Keeping the granularity at
//! *field* level (rather than whole-task) is what lets one peer retitle
//! a task while another moves its due date without either edit being
//! lost.
//!
//! Tags are modelled as one boolean entry per tag (`tag:dev`) rather
//! than a single array, so concurrent `+dev` / `+ui` both survive.
//! Deletion is a tombstone (`deleted = true`) — dropping the rows
//! outright would let a peer that hasn't heard about the delete
//! resurrect the task on the next sync.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::hlc::{Hlc, NodeId};

pub const FIELD_PARENT: &str = "parent";
pub const FIELD_TITLE: &str = "title";
pub const FIELD_NOTES: &str = "notes";
pub const FIELD_STATUS: &str = "status";
pub const FIELD_PRIORITY: &str = "priority";
pub const FIELD_START: &str = "start";
pub const FIELD_DURATION: &str = "duration";
pub const FIELD_DUE: &str = "due";
pub const FIELD_PROGRESS: &str = "progress";
pub const FIELD_POSITION: &str = "position";
pub const FIELD_CREATED: &str = "created";
pub const FIELD_DELETED: &str = "deleted";
pub const FIELD_EXISTS: &str = "exists";
/// Prefix for the per-tag boolean entries.
pub const TAG_PREFIX: &str = "tag:";

/// Key of the entity an entry belongs to: `task:<uuid>` or
/// `dep:<from>><to>`.
pub fn task_key(id: Uuid) -> String {
    format!("task:{id}")
}

pub fn dep_key(from: Uuid, to: Uuid) -> String {
    format!("dep:{from}>{to}")
}

/// Inverse of [`task_key`].
pub fn parse_task_key(key: &str) -> Option<Uuid> {
    key.strip_prefix("task:")?.parse().ok()
}

/// Inverse of [`dep_key`].
pub fn parse_dep_key(key: &str) -> Option<(Uuid, Uuid)> {
    let rest = key.strip_prefix("dep:")?;
    let (from, to) = rest.split_once('>')?;
    Some((from.parse().ok()?, to.parse().ok()?))
}

/// One replicated field value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub key: String,
    pub field: String,
    pub value: Value,
    pub hlc: Hlc,
    /// Position in the originating node's own write sequence. Paired
    /// with `hlc.node` this is what the version vector indexes.
    pub seq: u64,
}

impl Entry {
    pub fn origin(&self) -> NodeId {
        self.hlc.node
    }
}

/// Per-node high-water mark of writes this replica has seen.
///
/// Sync is "send me everything past this vector", which is O(changes)
/// rather than O(dataset) — and unlike a plain timestamp cutoff it stays
/// correct when peers' wall clocks disagree.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionVector(pub HashMap<NodeId, u64>);

impl VersionVector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, node: NodeId) -> u64 {
        self.0.get(&node).copied().unwrap_or(0)
    }

    /// Raise the mark for `node` if `seq` is higher.
    pub fn observe(&mut self, node: NodeId, seq: u64) {
        let slot = self.0.entry(node).or_insert(0);
        *slot = (*slot).max(seq);
    }

    /// Fold another vector in, keeping the per-node maximum.
    pub fn merge(&mut self, other: &VersionVector) {
        for (node, seq) in &other.0 {
            self.observe(*node, *seq);
        }
    }

    /// True when this replica has already seen the given write.
    pub fn covers(&self, node: NodeId, seq: u64) -> bool {
        seq <= self.get(node)
    }

    /// The entries in `all` that `remote` has not seen yet.
    pub fn diff<'a>(&self, all: impl IntoIterator<Item = &'a Entry>) -> Vec<Entry> {
        all.into_iter()
            .filter(|entry| !self.covers(entry.origin(), entry.seq))
            .cloned()
            .collect()
    }
}

/// Whether an incoming write beats what is already stored.
///
/// Ties are impossible in practice — the HLC carries the node id — but
/// the strict `>` keeps the operation idempotent, so replaying the same
/// sync batch twice is a no-op.
pub fn wins(existing: Option<&Hlc>, incoming: &Hlc) -> bool {
    match existing {
        None => true,
        Some(current) => incoming > current,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hlc(millis: u64, node: NodeId) -> Hlc {
        Hlc {
            millis,
            counter: 0,
            node,
        }
    }

    fn entry(key: &str, field: &str, millis: u64, node: NodeId, seq: u64) -> Entry {
        Entry {
            key: key.to_string(),
            field: field.to_string(),
            value: json!("v"),
            hlc: hlc(millis, node),
            seq,
        }
    }

    #[test]
    fn keys_round_trip() {
        let id = Uuid::new_v4();
        assert_eq!(parse_task_key(&task_key(id)), Some(id));

        let (from, to) = (Uuid::new_v4(), Uuid::new_v4());
        assert_eq!(parse_dep_key(&dep_key(from, to)), Some((from, to)));

        assert_eq!(parse_task_key("dep:x>y"), None);
        assert_eq!(parse_dep_key(&task_key(id)), None);
    }

    #[test]
    fn later_write_wins_and_replays_are_no_ops() {
        let node = Uuid::new_v4();
        let old = hlc(100, node);
        let new = hlc(200, node);
        assert!(wins(None, &old));
        assert!(wins(Some(&old), &new));
        assert!(!wins(Some(&new), &old));
        assert!(!wins(Some(&new), &new), "same entry applied twice");
    }

    #[test]
    fn version_vector_tracks_per_node_high_water_marks() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut vv = VersionVector::new();
        vv.observe(a, 5);
        vv.observe(a, 3);
        assert_eq!(vv.get(a), 5, "observe never lowers the mark");
        assert!(vv.covers(a, 5));
        assert!(!vv.covers(a, 6));
        assert!(!vv.covers(b, 1), "unknown node covers nothing");
    }

    #[test]
    fn diff_returns_only_what_the_remote_is_missing() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let all = vec![
            entry("task:1", "title", 10, a, 1),
            entry("task:1", "notes", 20, a, 2),
            entry("task:2", "title", 30, b, 1),
        ];

        let mut remote = VersionVector::new();
        remote.observe(a, 1);
        let missing = remote.diff(&all);

        assert_eq!(missing.len(), 2);
        assert!(missing.iter().any(|e| e.field == "notes"));
        assert!(missing.iter().any(|e| e.key == "task:2"));
    }

    #[test]
    fn merging_vectors_keeps_the_per_node_maximum() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut left = VersionVector::new();
        left.observe(a, 5);
        left.observe(b, 1);

        let mut right = VersionVector::new();
        right.observe(a, 2);
        right.observe(b, 9);

        left.merge(&right);
        assert_eq!(left.get(a), 5);
        assert_eq!(left.get(b), 9);
    }
}
