//! Hybrid logical clock.
//!
//! Wall clocks on two laptops disagree, and a pure Lamport counter loses
//! all relation to real time (a task edited yesterday could out-rank one
//! edited today). An HLC keeps timestamps within a bounded distance of
//! physical time while still guaranteeing that a causally later write
//! compares greater — which is exactly what last-writer-wins needs to be
//! deterministic across peers.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Identifies one replica (one running `yaiba` instance).
pub type NodeId = Uuid;

/// A point on the hybrid clock.
///
/// The derived `Ord` compares `millis`, then `counter`, then `node` —
/// the node id is the tiebreaker that makes concurrent writes resolve
/// the same way on every peer instead of depending on arrival order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Hlc {
    pub millis: u64,
    pub counter: u32,
    pub node: NodeId,
}

impl Hlc {
    /// Sorts below every real timestamp; used as the "no value yet" floor.
    pub const ZERO: Hlc = Hlc {
        millis: 0,
        counter: 0,
        node: Uuid::nil(),
    };
}

fn physical_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        // A clock set before 1970 is absurd, but panicking over it in a
        // todo app is worse; the logical counter still keeps ordering
        // correct.
        .unwrap_or(0)
}

/// Per-replica clock state. Persisted so a restart can't hand out
/// timestamps below ones already published to peers.
#[derive(Debug, Clone)]
pub struct Clock {
    node: NodeId,
    last_millis: u64,
    counter: u32,
}

impl Clock {
    pub fn new(node: NodeId) -> Self {
        Self {
            node,
            last_millis: 0,
            counter: 0,
        }
    }

    /// Restore from persisted state.
    pub fn restore(node: NodeId, last_millis: u64, counter: u32) -> Self {
        Self {
            node,
            last_millis,
            counter,
        }
    }

    pub fn node(&self) -> NodeId {
        self.node
    }

    pub fn state(&self) -> (u64, u32) {
        (self.last_millis, self.counter)
    }

    /// Timestamp for a local write. Strictly greater than every
    /// timestamp this clock has issued or observed.
    pub fn now(&mut self) -> Hlc {
        let physical = physical_millis();
        if physical > self.last_millis {
            self.last_millis = physical;
            self.counter = 0;
        } else {
            // Physical time stood still (or went backwards); keep
            // ordering with the logical counter.
            self.counter += 1;
        }
        Hlc {
            millis: self.last_millis,
            counter: self.counter,
            node: self.node,
        }
    }

    /// Fold in a timestamp received from a peer so that any later local
    /// write sorts above it.
    pub fn observe(&mut self, remote: Hlc) {
        let physical = physical_millis();
        let max = physical.max(self.last_millis).max(remote.millis);

        self.counter = if max == self.last_millis && max == remote.millis {
            self.counter.max(remote.counter) + 1
        } else if max == self.last_millis {
            self.counter + 1
        } else if max == remote.millis {
            remote.counter + 1
        } else {
            // Physical time moved past both — the counter can reset.
            0
        };
        self.last_millis = max;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successive_timestamps_strictly_increase() {
        let mut clock = Clock::new(Uuid::new_v4());
        let mut previous = clock.now();
        for _ in 0..1000 {
            let next = clock.now();
            assert!(next > previous, "{next:?} should sort above {previous:?}");
            previous = next;
        }
    }

    #[test]
    fn observing_a_future_peer_pushes_local_writes_above_it() {
        let mut clock = Clock::new(Uuid::new_v4());
        let far_future = Hlc {
            millis: physical_millis() + 60_000,
            counter: 7,
            node: Uuid::new_v4(),
        };
        clock.observe(far_future);
        assert!(clock.now() > far_future);
    }

    #[test]
    fn observing_the_past_does_not_move_the_clock_backwards() {
        let mut clock = Clock::new(Uuid::new_v4());
        let before = clock.now();
        clock.observe(Hlc {
            millis: 1,
            counter: 0,
            node: Uuid::new_v4(),
        });
        assert!(clock.now() > before);
    }

    #[test]
    fn node_id_breaks_ties_deterministically() {
        let low = Uuid::from_u128(1);
        let high = Uuid::from_u128(2);
        let a = Hlc {
            millis: 100,
            counter: 0,
            node: low,
        };
        let b = Hlc {
            millis: 100,
            counter: 0,
            node: high,
        };
        assert!(b > a);
    }

    #[test]
    fn zero_sorts_below_any_real_timestamp() {
        let mut clock = Clock::new(Uuid::new_v4());
        assert!(clock.now() > Hlc::ZERO);
    }
}
