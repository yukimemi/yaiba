//! SQLite persistence for the CRDT.
//!
//! The `crdt` table *is* the state: one row per `(entity, field)`
//! holding the winning value and the HLC that won it. Reads materialise
//! tasks by folding those rows; writes append a new row (or overwrite an
//! older one). Because LWW keeps only the latest value per field, the
//! table never grows with edit history — only with the number of fields
//! that have ever been touched.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use chrono::{DateTime, Local, NaiveDate, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::crdt::{
    Entry, FIELD_ACTUAL_END, FIELD_ACTUAL_START, FIELD_ASSIGNEE, FIELD_CREATED, FIELD_DELETED,
    FIELD_DUE, FIELD_DURATION, FIELD_EXISTS, FIELD_LAG, FIELD_NOTES, FIELD_PARENT, FIELD_POSITION,
    FIELD_PRIORITY, FIELD_PROGRESS, FIELD_START, FIELD_STATUS, FIELD_TITLE, TAG_PREFIX,
    VersionVector, dep_key, log_key, parse_dep_key, parse_log_key, parse_task_key, task_key,
};
use crate::graph;
use crate::hlc::{Clock, Hlc, NodeId};
use crate::model::{
    Dep, NewTask, Snapshot, Status, Task, TaskId, TaskPatch, clamp_lag, default_lag,
};
use crate::{Error, Result};

/// Gap left between adjacent `position` values so an insert between two
/// rows can pick a midpoint without renumbering the list.
const POSITION_GAP: f64 = 1024.0;

pub struct Store {
    conn: Connection,
    clock: Clock,
    /// This replica's own write counter — the `seq` half of every entry
    /// it originates.
    seq: u64,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Error::Other(e.into()))?;
        }
        Self::from_connection(Connection::open(path)?)
    }

    /// In-memory replica, used by tests.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let mut store = Self {
            conn,
            clock: Clock::new(Uuid::nil()),
            seq: 0,
        };
        store.migrate()?;

        // The node id is minted once and reused forever: it is half of
        // every HLC this replica issues, so a new id per start would
        // make old writes look like they came from a stranger.
        let node: NodeId = match store.meta_get("node_id")? {
            Some(v) => v
                .parse()
                .map_err(|e| Error::Other(anyhow::anyhow!("{e}")))?,
            None => {
                let node = Uuid::new_v4();
                store.meta_set("node_id", &node.to_string())?;
                node
            }
        };
        let millis = store.meta_get_u64("clock_ms")?;
        let counter = store.meta_get_u64("clock_ctr")? as u32;
        store.seq = store.meta_get_u64("seq")?;
        store.clock = Clock::restore(node, millis, counter);
        Ok(store)
    }

    fn migrate(&mut self) -> Result<()> {
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version < 1 {
            self.conn.execute_batch(
                r#"
                CREATE TABLE crdt (
                    key      TEXT    NOT NULL,
                    field    TEXT    NOT NULL,
                    value    TEXT    NOT NULL,
                    hlc_ms   INTEGER NOT NULL,
                    hlc_ctr  INTEGER NOT NULL,
                    hlc_node TEXT    NOT NULL,
                    seq      INTEGER NOT NULL,
                    PRIMARY KEY (key, field)
                );
                CREATE INDEX idx_crdt_origin ON crdt(hlc_node, seq);

                -- High-water mark per origin node. Kept separately from
                -- `crdt` because an overwritten entry takes its seq with
                -- it; without this table the version vector would slide
                -- backwards and peers would re-send settled writes.
                CREATE TABLE observed (
                    node    TEXT    PRIMARY KEY,
                    max_seq INTEGER NOT NULL
                );

                CREATE TABLE meta (
                    k TEXT PRIMARY KEY,
                    v TEXT NOT NULL
                );

                CREATE TABLE peers (
                    node      TEXT PRIMARY KEY,
                    ticket    TEXT NOT NULL,
                    label     TEXT NOT NULL DEFAULT '',
                    last_seen TEXT
                );
                PRAGMA user_version = 1;
                "#,
            )?;
        }
        Ok(())
    }

    pub fn node_id(&self) -> NodeId {
        self.clock.node()
    }

    // ---- metadata --------------------------------------------------

    /// Read a persisted key/value. The sync layer keeps its identity
    /// (secret key, room key) here so a restart rejoins as the same peer
    /// rather than as a stranger.
    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        self.meta_get(key)
    }

    /// Write a persisted key/value. See [`Store::meta`].
    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.meta_set(key, value)
    }

    fn meta_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT v FROM meta WHERE k = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    fn meta_get_u64(&self, key: &str) -> Result<u64> {
        Ok(self
            .meta_get(key)?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0))
    }

    fn meta_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (k, v) VALUES (?1, ?2)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            params![key, value],
        )?;
        Ok(())
    }

    // ---- reads -----------------------------------------------------

    fn entries(&self) -> Result<Vec<Entry>> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, field, value, hlc_ms, hlc_ctr, hlc_node, seq FROM crdt")?;
        let rows = stmt.query_map([], |row| {
            let node: String = row.get(5)?;
            Ok(Entry {
                key: row.get(0)?,
                field: row.get(1)?,
                value: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or(Value::Null),
                hlc: Hlc {
                    millis: row.get::<_, i64>(3)? as u64,
                    counter: row.get::<_, i64>(4)? as u32,
                    node: node.parse().unwrap_or_else(|_| Uuid::nil()),
                },
                seq: row.get::<_, i64>(6)? as u64,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Live tasks (tombstones excluded) and the edges between them,
    /// ordered by the manual `position` key.
    pub fn snapshot(&self) -> Result<Snapshot> {
        Ok(materialize(&self.entries()?))
    }

    /// The dataset as it stood at the end of `date`.
    ///
    /// Progress and status come from the day-keyed log: the value that
    /// was last recorded on or before `date`. A task with no observation
    /// by then had not been touched, so it reads as todo at 0%, and a
    /// task created afterwards is absent entirely.
    ///
    /// Everything else — titles, dates, the breakdown — is shown as it
    /// is *now*, not as it was. LWW keeps no history for those fields,
    /// and inventing one would be worse than the honest limitation.
    pub fn snapshot_at(&self, date: NaiveDate) -> Result<Snapshot> {
        let entries = self.entries()?;
        let mut snapshot = materialize(&entries);
        let history = history_index(&entries);
        let cutoff = date.to_string();

        // `created_at` is stamped in UTC but `date` is a local calendar
        // day, so the two have to be brought into the same frame first.
        // Comparing them raw drops a task created in the last hours of a
        // local day west of UTC out of its own ":asof today".
        snapshot
            .tasks
            .retain(|task| task.created_at.with_timezone(&Local).date_naive() <= date);
        for task in &mut snapshot.tasks {
            match history
                .get(&task.id)
                .and_then(|days| days.range(..=cutoff.clone()).next_back())
            {
                Some((_, (progress, status))) => {
                    task.progress = *progress;
                    task.status = *status;
                }
                None => {
                    task.progress = 0;
                    task.status = Status::Todo;
                }
            }
            // An actual date in the future of the as-of point hadn't
            // happened yet.
            task.actual_start = task.actual_start.filter(|d| *d <= date);
            task.actual_end = task.actual_end.filter(|d| *d <= date);
        }

        let live: HashSet<TaskId> = snapshot.tasks.iter().map(|t| t.id).collect();
        snapshot
            .deps
            .retain(|d| live.contains(&d.from) && live.contains(&d.to));
        Ok(snapshot)
    }

    /// Every recorded observation for a task, oldest first.
    pub fn history(&self, id: TaskId) -> Result<Vec<(NaiveDate, i64, Status)>> {
        let index = history_index(&self.entries()?);
        Ok(index
            .get(&id)
            .map(|days| {
                days.iter()
                    .filter_map(|(day, (progress, status))| {
                        day.parse().ok().map(|d| (d, *progress, *status))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub fn get_task(&self, id: TaskId) -> Result<Task> {
        self.snapshot()?
            .tasks
            .into_iter()
            .find(|t| t.id == id)
            .ok_or(Error::NotFound(id))
    }

    // ---- local writes ----------------------------------------------

    /// Apply a batch of local field writes atomically, stamping each with
    /// a fresh HLC and the next local sequence number.
    fn commit(&mut self, writes: Vec<(String, String, Value)>) -> Result<()> {
        if writes.is_empty() {
            return Ok(());
        }
        let mut clock = self.clock.clone();
        let mut seq = self.seq;
        let node = clock.node();

        let tx = self.conn.transaction()?;
        for (key, field, value) in writes {
            seq += 1;
            let hlc = clock.now();
            upsert(
                &tx,
                &Entry {
                    key,
                    field,
                    value,
                    hlc,
                    seq,
                },
            )?;
        }
        observe(&tx, node, seq)?;
        let (millis, counter) = clock.state();
        for (k, v) in [
            ("seq", seq.to_string()),
            ("clock_ms", millis.to_string()),
            ("clock_ctr", counter.to_string()),
        ] {
            tx.execute(
                "INSERT INTO meta (k, v) VALUES (?1, ?2)
                 ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                params![k, v],
            )?;
        }
        tx.commit()?;

        self.clock = clock;
        self.seq = seq;
        Ok(())
    }

    pub fn create_task(&mut self, new: NewTask) -> Result<Task> {
        let id = Uuid::now_v7();
        let key = task_key(id);
        let snapshot = self.snapshot()?;
        let position = next_position(&snapshot.tasks, new.after, new.before);
        let now = Utc::now();

        let mut writes = vec![
            (key.clone(), FIELD_PARENT.into(), json!(new.parent)),
            (key.clone(), FIELD_TITLE.into(), json!(new.title)),
            (key.clone(), FIELD_NOTES.into(), json!(new.notes)),
            (
                key.clone(),
                FIELD_ASSIGNEE.into(),
                json!(normalise_assignee(&new.assignee)),
            ),
            (key.clone(), FIELD_STATUS.into(), json!(new.status.as_str())),
            (
                key.clone(),
                FIELD_PRIORITY.into(),
                json!(new.priority.clamp(0, 3)),
            ),
            (key.clone(), FIELD_START.into(), json!(new.start)),
            (
                key.clone(),
                FIELD_DURATION.into(),
                json!(new.duration_days.unwrap_or(1).max(1)),
            ),
            (key.clone(), FIELD_DUE.into(), json!(new.due)),
            (
                key.clone(),
                FIELD_ACTUAL_START.into(),
                json!(new.actual_start),
            ),
            (key.clone(), FIELD_ACTUAL_END.into(), json!(new.actual_end)),
            (
                key.clone(),
                FIELD_PROGRESS.into(),
                json!(new.progress.clamp(0, 100)),
            ),
            (key.clone(), FIELD_POSITION.into(), json!(position)),
            (key.clone(), FIELD_CREATED.into(), json!(now.to_rfc3339())),
            (key.clone(), FIELD_DELETED.into(), json!(false)),
        ];
        for tag in normalise_tags(&new.tags) {
            writes.push((key.clone(), format!("{TAG_PREFIX}{tag}"), json!(true)));
        }
        // Record the creation state too. `NewTask` accepts a non-default
        // status and progress, and without this entry `snapshot_at` falls
        // back to "never observed" — reporting a task created as doing/50%
        // as todo/0% on the very day it was made.
        writes.extend(observation_writes(
            id,
            now.with_timezone(&Local).date_naive(),
            new.status,
            new.progress.clamp(0, 100),
        ));

        self.commit(writes)?;
        self.get_task(id)
    }

    /// Write every field of `task` verbatim and clear its tombstone.
    ///
    /// This is how undo resurrects a deleted task: rather than removing
    /// rows (which a peer would happily re-add on the next sync), it
    /// writes newer values that win the merge everywhere.
    pub fn put_task(&mut self, task: &Task) -> Result<Task> {
        let key = task_key(task.id);
        let existing_tags: HashSet<String> = self
            .snapshot()?
            .tasks
            .iter()
            .find(|t| t.id == task.id)
            .map(|t| t.tags.iter().cloned().collect())
            .unwrap_or_default();
        let wanted: HashSet<String> = normalise_tags(&task.tags).into_iter().collect();

        let mut writes = vec![
            (key.clone(), FIELD_PARENT.into(), json!(task.parent)),
            (key.clone(), FIELD_TITLE.into(), json!(task.title)),
            (key.clone(), FIELD_NOTES.into(), json!(task.notes)),
            (
                key.clone(),
                FIELD_ASSIGNEE.into(),
                json!(normalise_assignee(&task.assignee)),
            ),
            (
                key.clone(),
                FIELD_STATUS.into(),
                json!(task.status.as_str()),
            ),
            (
                key.clone(),
                FIELD_PRIORITY.into(),
                json!(task.priority.clamp(0, 3)),
            ),
            (key.clone(), FIELD_START.into(), json!(task.start)),
            (
                key.clone(),
                FIELD_DURATION.into(),
                json!(task.duration_days.max(1)),
            ),
            (key.clone(), FIELD_DUE.into(), json!(task.due)),
            (
                key.clone(),
                FIELD_ACTUAL_START.into(),
                json!(task.actual_start),
            ),
            (key.clone(), FIELD_ACTUAL_END.into(), json!(task.actual_end)),
            (
                key.clone(),
                FIELD_PROGRESS.into(),
                json!(task.progress.clamp(0, 100)),
            ),
            (key.clone(), FIELD_POSITION.into(), json!(task.position)),
            (
                key.clone(),
                FIELD_CREATED.into(),
                json!(task.created_at.to_rfc3339()),
            ),
            (key.clone(), FIELD_DELETED.into(), json!(false)),
        ];
        for tag in wanted.union(&existing_tags) {
            writes.push((
                key.clone(),
                format!("{TAG_PREFIX}{tag}"),
                json!(wanted.contains(tag)),
            ));
        }
        // Restoring a task re-establishes its state, so today's
        // observation has to say so as well.
        writes.extend(observation_writes(
            task.id,
            Local::now().date_naive(),
            task.status,
            task.progress.clamp(0, 100),
        ));

        self.commit(writes)?;
        self.get_task(task.id)
    }

    pub fn patch_task(&mut self, id: TaskId, patch: TaskPatch) -> Result<Task> {
        let current = self.get_task(id)?;
        let key = task_key(id);
        let mut writes = Vec::new();

        if let Some(v) = patch.parent {
            // Re-parenting is the one patch that can corrupt the shape
            // of the tree, so it is checked before anything is written.
            if let Some(new_parent) = v {
                if new_parent == id {
                    return Err(Error::ParentCycle);
                }
                let snapshot = self.snapshot()?;
                if !snapshot.tasks.iter().any(|t| t.id == new_parent) {
                    return Err(Error::NotFound(new_parent));
                }
                if is_descendant(&snapshot.tasks, new_parent, id) {
                    return Err(Error::ParentCycle);
                }
            }
            writes.push((key.clone(), FIELD_PARENT.into(), json!(v)));
        }
        if let Some(v) = patch.title {
            writes.push((key.clone(), FIELD_TITLE.into(), json!(v)));
        }
        if let Some(v) = patch.notes {
            writes.push((key.clone(), FIELD_NOTES.into(), json!(v)));
        }
        if let Some(v) = patch.assignee {
            writes.push((
                key.clone(),
                FIELD_ASSIGNEE.into(),
                json!(normalise_assignee(&v)),
            ));
        }
        if let Some(v) = patch.status {
            writes.push((key.clone(), FIELD_STATUS.into(), json!(v.as_str())));
        }
        if let Some(v) = patch.priority {
            writes.push((key.clone(), FIELD_PRIORITY.into(), json!(v.clamp(0, 3))));
        }
        if let Some(v) = patch.start {
            writes.push((key.clone(), FIELD_START.into(), json!(v)));
        }
        if let Some(v) = patch.duration_days {
            writes.push((key.clone(), FIELD_DURATION.into(), json!(v.max(1))));
        }
        if let Some(v) = patch.due {
            writes.push((key.clone(), FIELD_DUE.into(), json!(v)));
        }
        if let Some(v) = patch.actual_start {
            writes.push((key.clone(), FIELD_ACTUAL_START.into(), json!(v)));
        }
        if let Some(v) = patch.actual_end {
            writes.push((key.clone(), FIELD_ACTUAL_END.into(), json!(v)));
        }
        if let Some(v) = patch.progress {
            writes.push((key.clone(), FIELD_PROGRESS.into(), json!(v.clamp(0, 100))));
        }

        // Stamp the actual dates from the status transition, unless the
        // caller set them explicitly in this same patch. Recording when
        // work started is the kind of thing nobody remembers to do by
        // hand, and the status change already says it.
        let today = Local::now().date_naive();
        let next_status = patch.status.unwrap_or(current.status);
        if next_status != Status::Todo
            && current.actual_start.is_none()
            && patch.actual_start.is_none()
        {
            writes.push((key.clone(), FIELD_ACTUAL_START.into(), json!(today)));
        }
        if next_status == Status::Done && current.actual_end.is_none() && patch.actual_end.is_none()
        {
            writes.push((key.clone(), FIELD_ACTUAL_END.into(), json!(today)));
        }
        // Reopening clears the finish: a task being worked on again has
        // not finished, and leaving the old date would quietly corrupt
        // every plan-vs-actual comparison.
        //
        // This tests the *transition*, not just the resulting status.
        // Checking `next_status != Done` alone meant that once someone
        // backdated `actual_end` on a not-yet-done task, the very next
        // unrelated patch — a retitle, a tag — silently erased it.
        if patch.status.is_some()
            && current.status == Status::Done
            && next_status != Status::Done
            && patch.actual_end.is_none()
        {
            writes.push((key.clone(), FIELD_ACTUAL_END.into(), Value::Null));
        }

        // One observation per task per day. Same-day edits collapse to
        // that day's final value; different days never overwrite each
        // other, which is what makes "where was this on the 20th"
        // answerable at all.
        if patch.progress.is_some() || patch.status.is_some() {
            let progress = patch.progress.map_or(current.progress, |p| p.clamp(0, 100));
            writes.extend(observation_writes(id, today, next_status, progress));
        }
        if let Some(tags) = patch.tags {
            // Per-tag booleans, not a replaced array: two peers adding
            // different tags at the same time must both stick.
            let wanted: HashSet<String> = normalise_tags(&tags).into_iter().collect();
            let existing: HashSet<String> = current.tags.iter().cloned().collect();
            for tag in wanted.union(&existing) {
                writes.push((
                    key.clone(),
                    format!("{TAG_PREFIX}{tag}"),
                    json!(wanted.contains(tag)),
                ));
            }
        }

        self.commit(writes)?;
        self.get_task(id)
    }

    /// Tombstone the task. The row stays so the delete can propagate.
    pub fn delete_task(&mut self, id: TaskId) -> Result<()> {
        self.get_task(id)?;
        self.commit(vec![(task_key(id), FIELD_DELETED.into(), json!(true))])
    }

    /// Rewrite the manual ordering so the listed ids appear in sequence.
    pub fn reorder(&mut self, ids: &[TaskId]) -> Result<()> {
        let writes = ids
            .iter()
            .enumerate()
            .map(|(index, id)| {
                (
                    task_key(*id),
                    FIELD_POSITION.to_string(),
                    json!((index as f64 + 1.0) * POSITION_GAP),
                )
            })
            .collect();
        self.commit(writes)
    }

    /// Add an edge, or re-state the lag of one that already exists.
    ///
    /// Re-adding is deliberately not an error: `dep:<from>><to>` is a
    /// last-writer-wins row like any other, so writing it again is how a
    /// lag gets *changed*. That saves `:dep 3 +0` from having to unlink
    /// first, and it costs nothing — a cycle is the only thing an edge is
    /// refused for, and re-adding one cannot introduce a cycle that was
    /// not already there.
    pub fn add_dep(&mut self, from: TaskId, to: TaskId, lag_days: i64) -> Result<()> {
        if from == to {
            return Err(Error::SelfDep);
        }
        let snapshot = self.snapshot()?;
        if !snapshot.tasks.iter().any(|t| t.id == from) {
            return Err(Error::NotFound(from));
        }
        if !snapshot.tasks.iter().any(|t| t.id == to) {
            return Err(Error::NotFound(to));
        }
        if graph::would_cycle(&snapshot.deps, from, to) {
            return Err(Error::Cycle { from, to });
        }
        self.commit(vec![
            (dep_key(from, to), FIELD_EXISTS.into(), json!(true)),
            // Clamped at both ends rather than refused. Negative would
            // pull the successor *before* its predecessor's finish in the
            // forward pass, quietly inverting the edge. Absurdly large
            // would panic the date arithmetic and take the whole project's
            // readability with it — the scheduler runs on every read. The
            // store is the wrong place to argue about either, so it
            // saturates and `:dep` says no out loud.
            (
                dep_key(from, to),
                FIELD_LAG.into(),
                json!(clamp_lag(lag_days)),
            ),
        ])
    }

    pub fn remove_dep(&mut self, from: TaskId, to: TaskId) -> Result<()> {
        self.commit(vec![(dep_key(from, to), FIELD_EXISTS.into(), json!(false))])
    }

    // ---- sync ------------------------------------------------------

    /// What this replica has seen, per originating node.
    pub fn version_vector(&self) -> Result<VersionVector> {
        let mut stmt = self.conn.prepare("SELECT node, max_seq FROM observed")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
        })?;
        let mut vv = VersionVector::new();
        for row in rows {
            let (node, seq) = row?;
            if let Ok(node) = node.parse() {
                vv.observe(node, seq);
            }
        }
        Ok(vv)
    }

    /// Entries the peer described by `remote` has not seen.
    pub fn entries_since(&self, remote: &VersionVector) -> Result<Vec<Entry>> {
        Ok(remote.diff(self.entries()?.iter()))
    }

    /// Merge a batch received from a peer.
    ///
    /// `remote_vv` is the sender's version vector *at the time it built
    /// the batch*; adopting it wholesale is what lets the high-water
    /// mark skip over writes the sender has already overwritten. It is
    /// only adopted if the whole batch commits, so a truncated transfer
    /// can't leave this replica claiming to have seen more than it has.
    pub fn merge(&mut self, entries: &[Entry], remote_vv: &VersionVector) -> Result<usize> {
        let mut clock = self.clock.clone();
        let tx = self.conn.transaction()?;
        let mut applied = 0;
        for entry in entries {
            clock.observe(entry.hlc);
            if upsert(&tx, entry)? {
                applied += 1;
            }
            observe(&tx, entry.origin(), entry.seq)?;
        }
        for (node, seq) in &remote_vv.0 {
            observe(&tx, *node, *seq)?;
        }
        let (millis, counter) = clock.state();
        for (k, v) in [
            ("clock_ms", millis.to_string()),
            ("clock_ctr", counter.to_string()),
        ] {
            tx.execute(
                "INSERT INTO meta (k, v) VALUES (?1, ?2)
                 ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                params![k, v],
            )?;
        }
        tx.commit()?;
        self.clock = clock;
        Ok(applied)
    }

    // ---- peers -----------------------------------------------------

    pub fn upsert_peer(&self, node: &str, ticket: &str, label: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO peers (node, ticket, label) VALUES (?1, ?2, ?3)
             ON CONFLICT(node) DO UPDATE SET ticket = excluded.ticket,
                                             label = excluded.label",
            params![node, ticket, label],
        )?;
        Ok(())
    }

    pub fn list_peers(&self) -> Result<Vec<(String, String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT node, ticket, label FROM peers ORDER BY label, node")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn touch_peer(&self, node: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE peers SET last_seen = ?2 WHERE node = ?1",
            params![node, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
}

/// Insert or overwrite one entry, keeping the higher HLC. Returns
/// whether the stored state changed.
///
/// The comparison runs in SQL as a row-value comparison. That relies on
/// `hlc_node`'s text ordering matching `Uuid`'s numeric ordering — true
/// for the lowercase hyphenated form, which is fixed-width with the
/// hyphens in fixed positions.
fn upsert(tx: &rusqlite::Transaction<'_>, entry: &Entry) -> Result<bool> {
    let changed = tx.execute(
        "INSERT INTO crdt (key, field, value, hlc_ms, hlc_ctr, hlc_node, seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(key, field) DO UPDATE SET
            value = excluded.value, hlc_ms = excluded.hlc_ms,
            hlc_ctr = excluded.hlc_ctr, hlc_node = excluded.hlc_node,
            seq = excluded.seq
         WHERE (excluded.hlc_ms, excluded.hlc_ctr, excluded.hlc_node)
             > (crdt.hlc_ms, crdt.hlc_ctr, crdt.hlc_node)",
        params![
            entry.key,
            entry.field,
            serde_json::to_string(&entry.value).unwrap_or_else(|_| "null".into()),
            entry.hlc.millis as i64,
            entry.hlc.counter as i64,
            entry.hlc.node.to_string(),
            entry.seq as i64,
        ],
    )?;
    Ok(changed > 0)
}

fn observe(tx: &rusqlite::Transaction<'_>, node: NodeId, seq: u64) -> Result<()> {
    tx.execute(
        "INSERT INTO observed (node, max_seq) VALUES (?1, ?2)
         ON CONFLICT(node) DO UPDATE SET max_seq = max(max_seq, excluded.max_seq)",
        params![node.to_string(), seq as i64],
    )?;
    Ok(())
}

/// The day's observation of a task: one entry per field, under the
/// day-keyed log.
///
/// A done task records 100 whatever its percentage field says, so the
/// history matches what the UI shows — `x` sets status without touching
/// the number, and that is the common path.
fn observation_writes(
    id: TaskId,
    day: NaiveDate,
    status: Status,
    progress: i64,
) -> Vec<(String, String, Value)> {
    let key = log_key(id, &day.to_string());
    let observed = if status == Status::Done {
        100
    } else {
        progress.clamp(0, 100)
    };
    vec![
        (key.clone(), FIELD_PROGRESS.to_string(), json!(observed)),
        (key, FIELD_STATUS.to_string(), json!(status.as_str())),
    ]
}

/// Fold the day-keyed log entries into `task -> day -> (progress, status)`.
///
/// `BTreeMap` on the ISO day string is what makes "the last observation
/// on or before D" a range query rather than a scan — and ISO dates sort
/// correctly as text, so no parsing is needed to order them.
fn history_index(entries: &[Entry]) -> HashMap<TaskId, BTreeMap<String, (i64, Status)>> {
    let mut out: HashMap<TaskId, BTreeMap<String, (i64, Status)>> = HashMap::new();
    for entry in entries {
        let Some((id, day)) = parse_log_key(&entry.key) else {
            continue;
        };
        let slot = out
            .entry(id)
            .or_default()
            .entry(day)
            .or_insert((0, Status::Todo));
        match entry.field.as_str() {
            FIELD_PROGRESS => {
                if let Some(v) = entry.value.as_i64() {
                    slot.0 = v.clamp(0, 100);
                }
            }
            FIELD_STATUS => {
                if let Some(v) = entry.value.as_str() {
                    slot.1 = Status::parse(v);
                }
            }
            _ => {}
        }
    }
    out
}

/// Is `candidate` inside the subtree rooted at `ancestor`?
///
/// Used to refuse a re-parent that would put a task inside its own
/// descendants. The walk is bounded by the task count so a cycle that
/// arrived through a merge can't hang the check.
fn is_descendant(tasks: &[Task], candidate: TaskId, ancestor: TaskId) -> bool {
    let parents: HashMap<TaskId, Option<TaskId>> = tasks.iter().map(|t| (t.id, t.parent)).collect();
    let mut current = Some(candidate);
    for _ in 0..=tasks.len() {
        match current {
            Some(id) if id == ancestor => return true,
            Some(id) => current = parents.get(&id).copied().flatten(),
            None => return false,
        }
    }
    false
}

/// Strip the display `@` and trim, so `@yuki` and `yuki` are one person.
///
/// Case is *kept*: with no user table behind the name, the only record
/// of how somebody spells their own name is what was typed. Folding it
/// would be the store deciding that for them. Matching in the UI is
/// case-insensitive instead, which costs nothing and gets `Yuki` and
/// `yuki` to the same rows.
fn normalise_assignee(name: &str) -> String {
    name.trim().trim_start_matches('@').trim().to_string()
}

/// Strip the display `#` and drop blanks so `#dev` and `dev` are one tag.
fn normalise_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = tags
        .iter()
        .map(|t| t.trim().trim_start_matches('#').to_string())
        .filter(|t| !t.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The manual position a new task takes.
///
/// `before` wins over `after`: a caller that sets it is placing the task
/// above a known row, and falling back to "append" there would put it as
/// far from that row as the ordering allows.
fn next_position(tasks: &[Task], after: Option<TaskId>, before: Option<TaskId>) -> f64 {
    if let Some(anchor) = before.and_then(|id| tasks.iter().find(|t| t.id == id)) {
        let previous = tasks
            .iter()
            .map(|t| t.position)
            .filter(|p| *p < anchor.position)
            .fold(f64::NEG_INFINITY, f64::max);
        return if previous.is_finite() {
            (previous + anchor.position) / 2.0
        } else {
            // Nothing above the anchor, so there is a whole gap to take.
            anchor.position - POSITION_GAP
        };
    }
    match after.and_then(|id| tasks.iter().find(|t| t.id == id)) {
        Some(anchor) => {
            let next = tasks
                .iter()
                .map(|t| t.position)
                .filter(|p| *p > anchor.position)
                .fold(f64::INFINITY, f64::min);
            if next.is_finite() {
                (anchor.position + next) / 2.0
            } else {
                anchor.position + POSITION_GAP
            }
        }
        None => tasks.iter().map(|t| t.position).fold(0.0_f64, f64::max) + POSITION_GAP,
    }
}

/// Fold the flat entry list into tasks and edges.
fn materialize(entries: &[Entry]) -> Snapshot {
    // BTreeMap keeps the fold deterministic, which keeps `updated_at`
    // and tag ordering stable between two replicas holding the same data.
    let mut by_key: BTreeMap<&str, HashMap<&str, &Entry>> = BTreeMap::new();
    for entry in entries {
        by_key
            .entry(entry.key.as_str())
            .or_default()
            .insert(entry.field.as_str(), entry);
    }

    let mut tasks = Vec::new();
    let mut live: HashSet<TaskId> = HashSet::new();
    for (key, fields) in &by_key {
        let Some(id) = parse_task_key(key) else {
            continue;
        };
        if field_bool(fields, FIELD_DELETED).unwrap_or(false) {
            continue;
        }
        let updated_at = fields
            .values()
            .map(|e| e.hlc.millis)
            .max()
            .and_then(millis_to_utc)
            .unwrap_or_else(Utc::now);
        let created_at = fields
            .get(FIELD_CREATED)
            .and_then(|e| e.value.as_str())
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc))
            .or_else(|| {
                fields
                    .values()
                    .map(|e| e.hlc.millis)
                    .min()
                    .and_then(millis_to_utc)
            })
            .unwrap_or(updated_at);

        let status = fields
            .get(FIELD_STATUS)
            .and_then(|e| e.value.as_str())
            .map_or(Status::Todo, Status::parse);
        // Derived rather than stored: whenever the status entry last
        // changed *is* when it became done.
        let done_at = (status == Status::Done)
            .then(|| {
                fields
                    .get(FIELD_STATUS)
                    .and_then(|e| millis_to_utc(e.hlc.millis))
            })
            .flatten();

        let mut tags: Vec<String> = fields
            .iter()
            .filter_map(|(field, entry)| {
                let name = field.strip_prefix(TAG_PREFIX)?;
                entry
                    .value
                    .as_bool()
                    .unwrap_or(false)
                    .then(|| name.to_string())
            })
            .collect();
        tags.sort();

        live.insert(id);
        tasks.push(Task {
            id,
            parent: fields
                .get(FIELD_PARENT)
                .and_then(|e| e.value.as_str())
                .and_then(|s| s.parse().ok()),
            title: field_str(fields, FIELD_TITLE).unwrap_or_default(),
            notes: field_str(fields, FIELD_NOTES).unwrap_or_default(),
            assignee: field_str(fields, FIELD_ASSIGNEE).unwrap_or_default(),
            status,
            priority: field_i64(fields, FIELD_PRIORITY).unwrap_or(0),
            start: field_date(fields, FIELD_START),
            duration_days: field_i64(fields, FIELD_DURATION).unwrap_or(1).max(1),
            due: field_date(fields, FIELD_DUE),
            actual_start: field_date(fields, FIELD_ACTUAL_START),
            actual_end: field_date(fields, FIELD_ACTUAL_END),
            progress: field_i64(fields, FIELD_PROGRESS).unwrap_or(0).clamp(0, 100),
            position: fields
                .get(FIELD_POSITION)
                .and_then(|e| e.value.as_f64())
                .unwrap_or(0.0),
            tags,
            created_at,
            updated_at,
            done_at,
        });
    }

    tasks.sort_by(|a, b| {
        a.position
            .partial_cmp(&b.position)
            .unwrap_or(std::cmp::Ordering::Equal)
            // Two peers can concurrently claim the same position; the id
            // breaks the tie the same way on every replica.
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut deps: Vec<Dep> = by_key
        .iter()
        .filter_map(|(key, fields)| {
            let (from, to) = parse_dep_key(key)?;
            let exists = fields
                .get(FIELD_EXISTS)
                .and_then(|e| e.value.as_bool())
                .unwrap_or(false);
            // Absent reads as the historical spacing, which is what makes
            // every edge written before this field existed — and every
            // edge a replica that has never heard of it writes — schedule
            // exactly as it always did.
            // Clamped on the way out as well as in: a peer running any
            // version can put any number in this row, and the scheduler
            // has to survive reading it.
            let lag_days = clamp_lag(field_i64(fields, FIELD_LAG).unwrap_or_else(default_lag));
            // An edge pointing at a tombstoned task is dropped from the
            // materialised view but its entry is kept, so undeleting the
            // task brings the edge back.
            (exists && live.contains(&from) && live.contains(&to)).then_some(Dep {
                from,
                to,
                lag_days,
            })
        })
        .collect();
    deps.sort_by_key(|d| (d.from, d.to));

    Snapshot { tasks, deps }
}

fn millis_to_utc(millis: u64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(millis as i64)
}

fn field_str(fields: &HashMap<&str, &Entry>, name: &str) -> Option<String> {
    fields.get(name)?.value.as_str().map(str::to_string)
}

fn field_i64(fields: &HashMap<&str, &Entry>, name: &str) -> Option<i64> {
    fields.get(name)?.value.as_i64()
}

fn field_bool(fields: &HashMap<&str, &Entry>, name: &str) -> Option<bool> {
    fields.get(name)?.value.as_bool()
}

fn field_date(fields: &HashMap<&str, &Entry>, name: &str) -> Option<NaiveDate> {
    fields.get(name)?.value.as_str()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_task(title: &str) -> NewTask {
        NewTask {
            title: title.to_string(),
            ..Default::default()
        }
    }

    /// Full bidirectional sync, the way the transport layer drives it.
    fn sync(a: &mut Store, b: &mut Store) {
        let vv_b = b.version_vector().unwrap();
        let to_b = a.entries_since(&vv_b).unwrap();
        let vv_a = a.version_vector().unwrap();
        b.merge(&to_b, &vv_a).unwrap();

        let vv_b = b.version_vector().unwrap();
        let to_a = b.entries_since(&vv_a).unwrap();
        a.merge(&to_a, &vv_b).unwrap();
    }

    fn titles(store: &Store) -> Vec<String> {
        store
            .snapshot()
            .unwrap()
            .tasks
            .into_iter()
            .map(|t| t.title)
            .collect()
    }

    #[test]
    fn creates_and_reads_back_a_task() {
        let mut store = Store::open_in_memory().unwrap();
        let created = store
            .create_task(NewTask {
                title: "write the parser".into(),
                tags: vec!["dev".into(), "#ui".into()],
                duration_days: Some(3),
                ..Default::default()
            })
            .unwrap();

        let fetched = store.get_task(created.id).unwrap();
        assert_eq!(fetched.title, "write the parser");
        assert_eq!(fetched.duration_days, 3);
        // The leading '#' is stripped so `#ui` and `ui` are one tag.
        assert_eq!(fetched.tags, vec!["dev".to_string(), "ui".to_string()]);
        assert_eq!(fetched.assignee, "", "nobody owns it until someone does");
    }

    #[test]
    fn an_assignee_is_stripped_of_its_sigil_but_keeps_its_case() {
        let mut store = Store::open_in_memory().unwrap();
        let task = store
            .create_task(NewTask {
                title: "assign me".into(),
                assignee: "  @Yuki ".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(task.assignee, "Yuki");

        // Empty is how the field is cleared; there is no separate null.
        let cleared = store
            .patch_task(
                task.id,
                TaskPatch {
                    assignee: Some("  ".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.assignee, "");
    }

    #[test]
    fn restoring_a_task_brings_its_assignee_back() {
        let mut store = Store::open_in_memory().unwrap();
        let task = store
            .create_task(NewTask {
                title: "undo me".into(),
                assignee: "yuki".into(),
                ..Default::default()
            })
            .unwrap();
        store.delete_task(task.id).unwrap();

        // `put_task` is what undo replays, so a field it forgets to
        // write comes back empty after a delete is taken back.
        let restored = store.put_task(&task).unwrap();
        assert_eq!(restored.assignee, "yuki");
    }

    #[test]
    fn duration_is_clamped_to_at_least_one_day() {
        let mut store = Store::open_in_memory().unwrap();
        let created = store
            .create_task(NewTask {
                title: "zero day".into(),
                duration_days: Some(0),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(created.duration_days, 1);
    }

    #[test]
    fn patch_leaves_omitted_fields_alone_but_honours_explicit_null() {
        let mut store = Store::open_in_memory().unwrap();
        let created = store
            .create_task(NewTask {
                title: "with a due date".into(),
                due: NaiveDate::from_ymd_opt(2026, 9, 1),
                ..Default::default()
            })
            .unwrap();

        let patched = store
            .patch_task(
                created.id,
                TaskPatch {
                    title: Some("renamed".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(patched.title, "renamed");
        assert_eq!(patched.due, created.due);

        let cleared = store
            .patch_task(
                created.id,
                TaskPatch {
                    due: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(cleared.due.is_none());
    }

    #[test]
    fn done_at_tracks_the_status_entry() {
        let mut store = Store::open_in_memory().unwrap();
        let created = store.create_task(new_task("toggle me")).unwrap();
        assert!(created.done_at.is_none());

        let done = store
            .patch_task(
                created.id,
                TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(done.done_at.is_some());

        let reopened = store
            .patch_task(
                created.id,
                TaskPatch {
                    status: Some(Status::Todo),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(reopened.done_at.is_none());
    }

    #[test]
    fn insert_after_lands_between_its_neighbours() {
        let mut store = Store::open_in_memory().unwrap();
        let first = store.create_task(new_task("first")).unwrap();
        store.create_task(new_task("third")).unwrap();
        store
            .create_task(NewTask {
                title: "second".into(),
                after: Some(first.id),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(titles(&store), ["first", "second", "third"]);
    }

    /// `O` on the topmost row: the anchor is the only thing above the
    /// new task, and "no anchor above it" must not read as "append".
    #[test]
    fn insert_before_lands_above_its_anchor() {
        let mut store = Store::open_in_memory().unwrap();
        let first = store.create_task(new_task("second")).unwrap();
        store.create_task(new_task("third")).unwrap();
        store
            .create_task(NewTask {
                title: "first".into(),
                before: Some(first.id),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(titles(&store), ["first", "second", "third"]);
    }

    #[test]
    fn insert_before_a_middle_row_lands_between_its_neighbours() {
        let mut store = Store::open_in_memory().unwrap();
        store.create_task(new_task("first")).unwrap();
        let third = store.create_task(new_task("third")).unwrap();
        store
            .create_task(NewTask {
                title: "second".into(),
                before: Some(third.id),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(titles(&store), ["first", "second", "third"]);
    }

    #[test]
    fn rejects_cyclic_and_self_dependencies() {
        let mut store = Store::open_in_memory().unwrap();
        let a = store.create_task(new_task("a")).unwrap().id;
        let b = store.create_task(new_task("b")).unwrap().id;
        let c = store.create_task(new_task("c")).unwrap().id;

        store.add_dep(a, b, default_lag()).unwrap();
        store.add_dep(b, c, default_lag()).unwrap();

        assert!(matches!(
            store.add_dep(c, a, default_lag()),
            Err(Error::Cycle { .. })
        ));
        assert!(matches!(
            store.add_dep(a, a, default_lag()),
            Err(Error::SelfDep)
        ));
        assert_eq!(store.snapshot().unwrap().deps.len(), 2);
    }

    #[test]
    fn a_dependency_carries_its_lag_and_can_have_it_changed() {
        let mut store = Store::open_in_memory().unwrap();
        let a = store.create_task(new_task("a")).unwrap().id;
        let b = store.create_task(new_task("b")).unwrap().id;

        store.add_dep(a, b, 0).unwrap();
        let deps = store.snapshot().unwrap().deps;
        assert_eq!(deps.len(), 1);
        assert_eq!(deps[0].lag_days, 0);

        // Re-adding is how a lag is changed — no unlink first. The row is
        // LWW like any other, so the second write simply wins.
        store.add_dep(a, b, 3).unwrap();
        let deps = store.snapshot().unwrap().deps;
        assert_eq!(deps.len(), 1, "still one edge, not two");
        assert_eq!(deps[0].lag_days, 3);

        // Saturated, not honoured: a negative lag would invert the edge.
        store.add_dep(a, b, -2).unwrap();
        assert_eq!(store.snapshot().unwrap().deps[0].lag_days, 0);
    }

    #[test]
    fn an_edge_written_without_a_lag_reads_as_the_historical_spacing() {
        // What a replica that has never heard of the field produces: the
        // `exists` row alone. It has to keep scheduling the way it always
        // did rather than collapsing to a same-day hand-off, which is why
        // the default is 1 and not 0.
        let mut store = Store::open_in_memory().unwrap();
        let a = store.create_task(new_task("a")).unwrap().id;
        let b = store.create_task(new_task("b")).unwrap().id;

        store
            .commit(vec![(dep_key(a, b), FIELD_EXISTS.into(), json!(true))])
            .unwrap();

        let deps = store.snapshot().unwrap().deps;
        assert_eq!(deps.len(), 1);
        assert_eq!(deps[0].lag_days, default_lag());
        assert_eq!(deps[0].lag_days, 1);
    }

    #[test]
    fn a_lag_survives_a_sync_and_an_old_peers_edge_stays_at_one() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let x = a.create_task(new_task("x")).unwrap().id;
        let y = a.create_task(new_task("y")).unwrap().id;
        let z = a.create_task(new_task("z")).unwrap().id;
        a.add_dep(x, y, 0).unwrap();
        // The shape an older replica writes: `exists` and nothing else.
        a.commit(vec![(dep_key(y, z), FIELD_EXISTS.into(), json!(true))])
            .unwrap();

        sync(&mut a, &mut b);

        let sa = a.snapshot().unwrap();
        let sb = b.snapshot().unwrap();
        assert_eq!(sa.deps, sb.deps, "both replicas agree on the lag too");

        let lag_of = |s: &Snapshot, from: TaskId, to: TaskId| {
            s.deps
                .iter()
                .find(|d| d.from == from && d.to == to)
                .unwrap()
                .lag_days
        };
        assert_eq!(lag_of(&sb, x, y), 0, "the explicit lag crossed the wire");
        assert_eq!(lag_of(&sb, y, z), 1, "the fieldless edge reads as before");
    }

    #[test]
    fn deleting_a_task_hides_it_and_its_edges() {
        let mut store = Store::open_in_memory().unwrap();
        let a = store.create_task(new_task("a")).unwrap().id;
        let b = store.create_task(new_task("b")).unwrap().id;
        store.add_dep(a, b, default_lag()).unwrap();

        store.delete_task(a).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.tasks.len(), 1);
        assert!(snapshot.deps.is_empty());
        assert!(matches!(store.delete_task(a), Err(Error::NotFound(_))));
    }

    #[test]
    fn put_task_resurrects_a_deleted_task_with_its_edges() {
        let mut store = Store::open_in_memory().unwrap();
        let a = store.create_task(new_task("a")).unwrap();
        let b = store.create_task(new_task("b")).unwrap().id;
        store.add_dep(a.id, b, default_lag()).unwrap();
        store.delete_task(a.id).unwrap();

        store.put_task(&a).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.tasks.len(), 2);
        assert_eq!(snapshot.deps.len(), 1, "the edge comes back with the task");
    }

    #[test]
    fn reorder_rewrites_the_manual_ordering() {
        let mut store = Store::open_in_memory().unwrap();
        let a = store.create_task(new_task("a")).unwrap().id;
        let b = store.create_task(new_task("b")).unwrap().id;
        let c = store.create_task(new_task("c")).unwrap().id;

        store.reorder(&[c, a, b]).unwrap();
        assert_eq!(titles(&store), ["c", "a", "b"]);
    }

    // ---- plan vs actual, and history -------------------------------

    #[test]
    fn actual_dates_follow_the_status_transitions() {
        let mut store = Store::open_in_memory().unwrap();
        let today = Local::now().date_naive();
        let task = store.create_task(new_task("build it")).unwrap();
        assert!(task.actual_start.is_none() && task.actual_end.is_none());

        let doing = store
            .patch_task(
                task.id,
                TaskPatch {
                    status: Some(Status::Doing),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(doing.actual_start, Some(today), "starting stamps a start");
        assert!(doing.actual_end.is_none());

        let done = store
            .patch_task(
                task.id,
                TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(done.actual_start, Some(today), "the start is not rewritten");
        assert_eq!(done.actual_end, Some(today));

        // Reopening must clear the finish, or every plan-vs-actual
        // comparison downstream quietly compares against a lie.
        let reopened = store
            .patch_task(
                task.id,
                TaskPatch {
                    status: Some(Status::Doing),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(reopened.actual_end.is_none());
        assert_eq!(reopened.actual_start, Some(today));
    }

    #[test]
    fn an_explicit_actual_date_is_not_overwritten_by_the_transition() {
        let mut store = Store::open_in_memory().unwrap();
        let backdated = NaiveDate::from_ymd_opt(2026, 1, 5).unwrap();
        let task = store.create_task(new_task("started last week")).unwrap();

        // Recording it after the fact must win over "today".
        let patched = store
            .patch_task(
                task.id,
                TaskPatch {
                    status: Some(Status::Doing),
                    actual_start: Some(Some(backdated)),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(patched.actual_start, Some(backdated));
    }

    #[test]
    fn a_backdated_finish_survives_unrelated_patches() {
        // Recording `actual_end` on a task that isn't done is supported.
        // Clearing it on any patch whose *result* isn't done meant the
        // next retitle silently erased it.
        let mut store = Store::open_in_memory().unwrap();
        let recorded = NaiveDate::from_ymd_opt(2026, 3, 3).unwrap();
        let task = store
            .create_task(new_task("logged after the fact"))
            .unwrap();
        store
            .patch_task(
                task.id,
                TaskPatch {
                    actual_end: Some(Some(recorded)),
                    ..Default::default()
                },
            )
            .unwrap();

        let after = store
            .patch_task(
                task.id,
                TaskPatch {
                    title: Some("renamed".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(after.actual_end, Some(recorded));

        // A real reopen still clears it.
        store
            .patch_task(
                task.id,
                TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        let reopened = store
            .patch_task(
                task.id,
                TaskPatch {
                    status: Some(Status::Doing),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(reopened.actual_end.is_none());
    }

    #[test]
    fn the_creation_state_is_in_the_history() {
        // A task created as doing/40% must not read as todo/0% under
        // snapshot_at on the day it was created.
        let mut store = Store::open_in_memory().unwrap();
        let today = Local::now().date_naive();
        let created = store
            .create_task(NewTask {
                title: "already underway".into(),
                status: Status::Doing,
                progress: 40,
                ..Default::default()
            })
            .unwrap();

        let same_day = store.snapshot_at(today).unwrap();
        let seen = same_day
            .tasks
            .iter()
            .find(|t| t.id == created.id)
            .expect("created today, so present in today's snapshot");
        assert_eq!((seen.status, seen.progress), (Status::Doing, 40));
    }

    #[test]
    fn a_task_created_today_appears_in_todays_snapshot() {
        // `created_at` is UTC and the as-of date is local; comparing them
        // raw dropped tasks created late in the day west of UTC.
        let mut store = Store::open_in_memory().unwrap();
        let created = store.create_task(new_task("made just now")).unwrap();
        let today = Local::now().date_naive();
        assert!(
            store
                .snapshot_at(today)
                .unwrap()
                .tasks
                .iter()
                .any(|t| t.id == created.id)
        );
    }

    #[test]
    fn progress_changes_are_recorded_once_per_day() {
        let mut store = Store::open_in_memory().unwrap();
        let today = Local::now().date_naive();
        let task = store.create_task(new_task("track me")).unwrap();

        for p in [20, 50, 70] {
            store
                .patch_task(
                    task.id,
                    TaskPatch {
                        progress: Some(p),
                        ..Default::default()
                    },
                )
                .unwrap();
        }

        let history = store.history(task.id).unwrap();
        assert_eq!(history.len(), 1, "three edits on one day collapse to one");
        assert_eq!(
            history[0],
            (today, 70, Status::Todo),
            "the day's final value"
        );
    }

    #[test]
    fn snapshot_at_reports_the_state_of_that_day() {
        let mut store = Store::open_in_memory().unwrap();
        let today = Local::now().date_naive();
        let yesterday = today.pred_opt().unwrap();
        let task = store.create_task(new_task("in flight")).unwrap();
        store
            .patch_task(
                task.id,
                TaskPatch {
                    progress: Some(60),
                    status: Some(Status::Doing),
                    ..Default::default()
                },
            )
            .unwrap();

        let now = store.snapshot_at(today).unwrap();
        assert_eq!(now.tasks[0].progress, 60);
        assert_eq!(now.tasks[0].status, Status::Doing);

        // Yesterday the work hadn't been recorded yet, so it reads as
        // untouched rather than inheriting today's number.
        let before = store.snapshot_at(yesterday).unwrap();
        assert!(
            before.tasks.is_empty(),
            "the task didn't exist yesterday either"
        );
    }

    #[test]
    fn a_done_task_logs_100_regardless_of_the_progress_field() {
        let mut store = Store::open_in_memory().unwrap();
        let task = store.create_task(new_task("finish")).unwrap();
        store
            .patch_task(
                task.id,
                TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();

        let history = store.history(task.id).unwrap();
        assert_eq!(history.last().unwrap().1, 100);
    }

    #[test]
    fn history_survives_a_sync() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let task = a.create_task(new_task("shared work")).unwrap();
        a.patch_task(
            task.id,
            TaskPatch {
                progress: Some(45),
                ..Default::default()
            },
        )
        .unwrap();

        sync(&mut a, &mut b);

        // The log rides the ordinary entry sync — no extra transport.
        assert_eq!(b.history(task.id).unwrap(), a.history(task.id).unwrap());
        assert_eq!(b.history(task.id).unwrap().len(), 1);
    }

    // ---- replication ----------------------------------------------

    #[test]
    fn two_replicas_converge_on_disjoint_creates() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        a.create_task(new_task("from a")).unwrap();
        b.create_task(new_task("from b")).unwrap();

        sync(&mut a, &mut b);

        assert_eq!(a.snapshot().unwrap().tasks.len(), 2);
        assert_eq!(titles(&a), titles(&b));
    }

    #[test]
    fn concurrent_edits_to_different_fields_both_survive() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let task = a.create_task(new_task("shared")).unwrap();
        sync(&mut a, &mut b);

        a.patch_task(
            task.id,
            TaskPatch {
                due: Some(NaiveDate::from_ymd_opt(2026, 12, 24)),
                ..Default::default()
            },
        )
        .unwrap();
        b.patch_task(
            task.id,
            TaskPatch {
                priority: Some(3),
                ..Default::default()
            },
        )
        .unwrap();

        sync(&mut a, &mut b);

        let merged = a.get_task(task.id).unwrap();
        assert_eq!(merged.due, NaiveDate::from_ymd_opt(2026, 12, 24));
        assert_eq!(merged.priority, 3);
        assert_eq!(merged.priority, b.get_task(task.id).unwrap().priority);
    }

    #[test]
    fn concurrent_edits_to_the_same_field_resolve_identically() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let task = a.create_task(new_task("shared")).unwrap();
        sync(&mut a, &mut b);

        a.patch_task(
            task.id,
            TaskPatch {
                title: Some("a wins?".into()),
                ..Default::default()
            },
        )
        .unwrap();
        b.patch_task(
            task.id,
            TaskPatch {
                title: Some("b wins?".into()),
                ..Default::default()
            },
        )
        .unwrap();

        sync(&mut a, &mut b);

        // Which one wins depends on the HLC, but both replicas must
        // agree — that is the property worth asserting.
        assert_eq!(
            a.get_task(task.id).unwrap().title,
            b.get_task(task.id).unwrap().title
        );
    }

    #[test]
    fn concurrent_assignees_converge_on_one() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let task = a.create_task(new_task("whose is this")).unwrap();
        sync(&mut a, &mut b);

        a.patch_task(
            task.id,
            TaskPatch {
                assignee: Some("yuki".into()),
                ..Default::default()
            },
        )
        .unwrap();
        b.patch_task(
            task.id,
            TaskPatch {
                assignee: Some("sato".into()),
                ..Default::default()
            },
        )
        .unwrap();

        sync(&mut a, &mut b);

        // The opposite of `concurrent_tag_adds_both_stick`, and
        // deliberately so: one owner is the point of the field, so the
        // two replicas have to land on the *same* one rather than
        // accumulate both.
        let settled = a.get_task(task.id).unwrap().assignee;
        assert_eq!(settled, b.get_task(task.id).unwrap().assignee);
        assert!(settled == "yuki" || settled == "sato");
    }

    #[test]
    fn concurrent_tag_adds_both_stick() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let task = a.create_task(new_task("tag me")).unwrap();
        sync(&mut a, &mut b);

        a.patch_task(
            task.id,
            TaskPatch {
                tags: Some(vec!["dev".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        b.patch_task(
            task.id,
            TaskPatch {
                tags: Some(vec!["ui".into()]),
                ..Default::default()
            },
        )
        .unwrap();

        sync(&mut a, &mut b);

        assert_eq!(
            a.get_task(task.id).unwrap().tags,
            vec!["dev".to_string(), "ui".to_string()],
            "per-tag booleans merge; a replaced array would lose one"
        );
    }

    #[test]
    fn a_delete_is_not_resurrected_by_a_stale_peer() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let task = a.create_task(new_task("doomed")).unwrap();
        sync(&mut a, &mut b);

        a.delete_task(task.id).unwrap();
        sync(&mut a, &mut b);
        // b syncs again with nothing new to say; the tombstone holds.
        sync(&mut a, &mut b);

        assert!(a.snapshot().unwrap().tasks.is_empty());
        assert!(b.snapshot().unwrap().tasks.is_empty());
    }

    #[test]
    fn an_edit_after_a_delete_wins_and_brings_the_task_back() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let task = a.create_task(new_task("contested")).unwrap();
        sync(&mut a, &mut b);

        a.delete_task(task.id).unwrap();
        sync(&mut a, &mut b);

        // b explicitly restores it — a later write on the `deleted`
        // field, so it beats the tombstone everywhere.
        b.put_task(&task).unwrap();
        sync(&mut a, &mut b);

        assert_eq!(a.snapshot().unwrap().tasks.len(), 1);
        assert_eq!(b.snapshot().unwrap().tasks.len(), 1);
    }

    #[test]
    fn sync_is_idempotent_and_converges_from_either_direction() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let x = a.create_task(new_task("x")).unwrap().id;
        let y = b.create_task(new_task("y")).unwrap().id;
        sync(&mut a, &mut b);

        a.add_dep(x, y, default_lag()).unwrap();
        sync(&mut a, &mut b);
        sync(&mut b, &mut a);
        sync(&mut a, &mut b);

        let sa = a.snapshot().unwrap();
        let sb = b.snapshot().unwrap();
        assert_eq!(sa.deps, sb.deps);
        assert_eq!(sa.deps.len(), 1);
        assert_eq!(
            sa.tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            sb.tasks.iter().map(|t| t.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_second_sync_with_no_changes_transfers_nothing() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        a.create_task(new_task("only once")).unwrap();
        sync(&mut a, &mut b);

        let vv_b = b.version_vector().unwrap();
        assert!(
            a.entries_since(&vv_b).unwrap().is_empty(),
            "settled writes must not be re-sent every round"
        );
    }

    #[test]
    fn node_id_and_clock_survive_a_reopen() {
        let dir = std::env::temp_dir().join(format!("yaiba-test-{}", Uuid::new_v4()));
        let path = dir.join("yaiba.db");

        let (node, seq) = {
            let mut store = Store::open(&path).unwrap();
            store.create_task(new_task("persisted")).unwrap();
            (store.node_id(), store.version_vector().unwrap())
        };

        let store = Store::open(&path).unwrap();
        assert_eq!(store.node_id(), node);
        assert_eq!(store.version_vector().unwrap(), seq);
        assert_eq!(titles(&store), ["persisted"]);

        std::fs::remove_dir_all(&dir).ok();
    }
}
