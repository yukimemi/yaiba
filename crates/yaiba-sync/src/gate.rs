//! The store, gated on whether this replica still accepts merges.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use yaiba_core::Store;

/// The store, and whether this replica still accepts merges into it.
///
/// One type because the two are only meaningful together. Aborting the
/// accept loop stops *new* connections being taken, but each one already
/// taken is served on a detached task nothing holds a handle to, so a
/// dial that was mid-handshake when shutdown landed would go on to merge
/// seconds later. Consulting a flag instead only narrows that window —
/// several awaits sit between the handshake and the merge — unless the
/// check and the merge share the store's lock, and closing takes that
/// same lock.
///
/// Keeping them in one type is what makes that testable without an
/// endpoint, a peer or a timing window: see the tests below.
///
/// It lives in its own module for the other half of that: `store` is
/// private to this file, so the only way to reach the store at all is
/// through a method that knows the flag exists. A merge-like call site
/// added later cannot bypass the check by not routing through
/// [`Gate::merge`] — there is nothing else to route through.
pub(crate) struct Gate {
    store: Arc<Mutex<Store>>,
    closed: AtomicBool,
}

impl Gate {
    pub(crate) fn new(store: Arc<Mutex<Store>>) -> Self {
        Self {
            store,
            closed: AtomicBool::new(false),
        }
    }

    /// Run a store operation without holding the lock across an await.
    pub(crate) fn with_store<T>(
        &self,
        f: impl FnOnce(&mut Store) -> yaiba_core::Result<T>,
    ) -> Result<T> {
        let mut db = self.store.lock().unwrap_or_else(|e| e.into_inner());
        Ok(f(&mut db)?)
    }

    /// Merge, unless this replica has been closed.
    ///
    /// The check and the merge share the store's lock, and [`Gate::close`]
    /// takes that same lock to set the flag, so the two cannot interleave.
    ///
    /// A merge already under way when `close` is called therefore runs to
    /// completion and `close` waits for it. That is the boundary meaning
    /// "nothing lands after the close", not "nothing lands during it" —
    /// the alternative would be abandoning a half-applied batch.
    pub(crate) fn merge(
        &self,
        entries: &[yaiba_core::Entry],
        vv: &yaiba_core::VersionVector,
    ) -> Result<usize> {
        let mut db = self.store.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.load(Ordering::SeqCst) {
            bail!("refused a merge: this node has been shut down");
        }
        Ok(db.merge(entries, vv)?)
    }

    /// Refuse every merge from here on. Idempotent.
    pub(crate) fn close(&self) {
        let _db = self.store.lock().unwrap_or_else(|e| e.into_inner());
        self.closed.store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

/// The shutdown guarantee, without a network.
///
/// These exist because the guarantee was got wrong three times, and each
/// time the bug survived review: it is a claim about lock ordering, and
/// reading the code is exactly the way not to see it. Reproducing it
/// through two live endpoints would mean losing a race on purpose, so the
/// logic lives here instead — a type that needs no endpoint, no peer and
/// no timing window to exercise.
#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use yaiba_core::{NewTask, VersionVector};

    /// A gate over an empty store, and one peer's worth of entries to
    /// merge into it.
    fn gate_and_batch() -> (Gate, Vec<yaiba_core::Entry>, VersionVector) {
        let mut peer = Store::open_in_memory().unwrap();
        peer.create_task(NewTask {
            title: "written by a peer".into(),
            ..Default::default()
        })
        .unwrap();
        let vv = peer.version_vector().unwrap();
        let entries = peer.entries_since(&VersionVector::default()).unwrap();
        assert!(!entries.is_empty(), "the batch has to be worth merging");

        let store = Store::open_in_memory().unwrap();
        (Gate::new(Arc::new(Mutex::new(store))), entries, vv)
    }

    fn task_count(gate: &Gate) -> usize {
        gate.with_store(|db| db.snapshot()).unwrap().tasks.len()
    }

    #[test]
    fn merges_while_open() {
        let (gate, entries, vv) = gate_and_batch();
        assert!(gate.merge(&entries, &vv).unwrap() > 0);
        assert_eq!(task_count(&gate), 1);
    }

    #[test]
    fn refuses_merges_after_close() {
        let (gate, entries, vv) = gate_and_batch();
        gate.close();

        let refused = gate.merge(&entries, &vv).unwrap_err();
        assert!(
            refused.to_string().contains("shut down"),
            "unexpected error: {refused:#}"
        );
        // Refused before `Store::merge`, so nothing landed half-applied.
        assert_eq!(task_count(&gate), 0);
    }

    #[test]
    fn close_is_idempotent() {
        let (gate, entries, vv) = gate_and_batch();
        gate.close();
        gate.close();
        assert!(gate.is_closed());
        assert!(gate.merge(&entries, &vv).is_err());
    }

    /// The point of the whole arrangement: a merge that has already taken
    /// the store lock finishes, and `close` waits for it rather than
    /// setting the flag underneath it.
    ///
    /// Stands in for the merge by holding the lock directly — the window
    /// the flag has to survive is the one where the lock is held, and it
    /// is held for all of [`Gate::merge`].
    #[test]
    fn close_waits_for_a_merge_already_running() {
        let (gate, _entries, _vv) = gate_and_batch();
        let (closed_tx, closed_rx) = mpsc::channel();

        thread::scope(|scope| {
            let held = gate.store.lock().unwrap();

            scope.spawn(|| {
                gate.close();
                let _ = closed_tx.send(());
            });

            // Not a race: this can only fail if `close` set the flag
            // while the lock was held, which is the bug.
            thread::sleep(Duration::from_millis(50));
            assert!(!gate.is_closed(), "closed while a merge held the store");

            drop(held);
            closed_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("close never completed after the store was released");
            assert!(gate.is_closed());
        });
    }
}
