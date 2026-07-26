<p align="center">
  <img src="https://raw.githubusercontent.com/yukimemi/yaiba/main/assets/logo.svg" alt="yaiba — vim-flavoured todo &amp; gantt, peer to peer" width="620">
</p>

# yaiba-core

Domain model, CRDT store and dependency-graph scheduling for
[yaiba](https://github.com/yukimemi/yaiba) — 刃, a vim-flavoured todo and
gantt planner that syncs peer-to-peer.

This is the engine, not the app. Install
[`yaiba`](https://crates.io/crates/yaiba) if you want the tool.

## What's in here

**A replicated data model.** Everything a user can change is one entry
in a last-writer-wins map keyed by `(task, field)`, stamped with a
hybrid logical clock. Field-level granularity is what makes concurrent
editing unremarkable: set a due date while someone else raises the
priority of the same task and both survive. Tags are one entry per tag
rather than a replaced array, and deletes leave a tombstone so a peer
that hasn't heard about them can't resurrect the task.

**Dependency scheduling.** A forward pass over the finish-to-start DAG
gives each task its earliest start; a backward pass gives slack, and
zero-slack tasks form the critical path.

**A work breakdown.** Tasks nest. A task with children is a summary: its
span is the union of its children's and its progress their
duration-weighted roll-up. Only leaves are scheduled from dependencies —
giving a summary its own dates would produce a second answer competing
with the roll-up.

**Recorded history.** Progress and status are logged per task per day,
so `snapshot_at(date)` can report the plan as it stood then rather than
back-projecting today's numbers.

Both graph structures degrade rather than fail on a bad merge: two peers
can concurrently close a dependency loop or re-parent into a cycle, so a
malformed graph is a state the renderer has to survive, not an error it
can refuse.

## License

MIT
