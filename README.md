<p align="center">
  <img src="https://raw.githubusercontent.com/yukimemi/yaiba/main/assets/logo.svg" alt="yaiba — vim-flavoured todo & gantt, peer to peer" width="620">
</p>

> 刃 — *the blade*. A vim-flavoured todo and gantt planner that runs as a
> single local binary and syncs directly between people. No server to
> host, no account to make.

**Status: released — modal UI, a foldable work breakdown, dependency
scheduling with a critical path, and peer-to-peer replication over
[iroh](https://iroh.computer). `cargo install yaiba`.**

## Why

Task tools make you choose. Terminal tools are fast to type into but
can't draw a timeline. Web planners draw beautiful gantt charts and then
ask you to reach for the mouse — and to put your plans on someone else's
server.

`yaiba` refuses the choice:

- **The keyboard is the interface.** Modal editing, `:` commands,
  operators that wait for a motion. `o` opens a row and you type; `x`
  completes it; `dd` deletes and `u` brings it back.
- **Dependencies are real, not decoration.** Finish-to-start edges feed a
  forward/backward pass that computes each task's earliest start, its
  slack, and the critical path — so "when does this actually land"
  has an answer rather than a guess.
- **One outline, every altitude.** Tasks nest, and folding to a level
  changes who the view is for: level 0 is the project list a manager
  scans, level 4 is the work an implementer is actually doing. Same
  data, same keys.
- **One binary.** The UI is compiled in. Download, run, work.
- **Peer-to-peer, not client-server.** Everyone runs their own replica.
  Edits merge; nobody hosts.

## Install

From crates.io, or build from source:

```sh
cargo install yaiba
yaiba
```

Prebuilt binaries for Linux / macOS / Windows are on the
[releases page](https://github.com/yukimemi/yaiba/releases). To build it
yourself:

```sh
git clone https://github.com/yukimemi/yaiba
cd yaiba
cargo make release-build     # builds the web bundle, then the binary
./target/release/yaiba
```

The browser opens on `http://localhost:8188`. The database lives in your
platform data directory (`--db` to move it).

```sh
yaiba --port 9000            # somewhere else
yaiba --no-open              # don't launch a browser
yaiba --no-sync              # fully local, no peer endpoint at all
yaiba --host 0.0.0.0         # expose the UI on your LAN (no auth — trusted networks only)
```

### Staying current

`yaiba` updates itself. On launch it quietly checks GitHub for a newer
release and, if there is one, downloads and swaps its own binary in the
background — the running process keeps the old one, so an update never
pulls the floor out from under an open UI. The new version applies next
time you start it.

```sh
yaiba --update notify        # tell me, don't touch the binary
yaiba --update off           # never look
YAIBA_NO_AUTOUPDATE=1 yaiba  # same, from the environment

yaiba self-update            # do it now, interactively
yaiba self-update --check    # just tell me whether one exists
```

## Keys

`?` shows the full list in the app. The shape of it:

| | |
|---|---|
| `j` `k` `gg` `G` `^d` `^u` | move |
| `o` `O` | new task below / above — you type immediately, it saves on commit |
| `i` `a` `c` | edit the title |
| `x` | complete (the row gets cut) · `s` cycles todo → doing → done |
| `dd` `yy` `p` | delete, yank, paste · `u` / `^r` undo, redo |
| `J` `K` | move the row within the manual order |
| `+` `-` | duration ±1 day · `gp` `gP` priority · `(` `)` progress |
| `D` | add a dependency: pick the task this one waits for, `⏎` |
| `X` | cut a dependency |
| `v` | visual line select — every edit above applies to the block |
| `/` `n` `N` | search |
| `tab` | split → list → gantt · `[` `]` zoom the timeline |
| `>>` `<<` | nest under the row above / move back out |
| `zm` `zr` | fold one level shallower / deeper · `zM` `zR` all the way |
| `za` | fold this row · `zf` focus its subtree, `zF` to come back |

## Projects, and the level you look at them from

There is no separate "project" object: a task with no parent *is* a
project. That means the same fold commands that collapse a sub-task
collapse a whole project, and one gantt spans all of them.

```
zM              every project on one screen, each showing its own roll-up
zr              open one level — the phases inside each project
zf              zoom into just this subtree
:level 2        jump straight to an altitude
```

A task with children becomes a **summary**: its bar spans its children's
dates and its percentage is their duration-weighted roll-up, so a
9-day task at 100% and a 1-day task at 0% reads 90%, not 50%. You never
type a summary's dates — they are a consequence of the work inside it.

Dependencies and nesting are separate axes on purpose: a parent
*contains* its children, a dependency *orders* two tasks. Only leaves
are scheduled from dependencies; summaries follow.

Commands take dates the way you'd say them: `:due tom`, `:due mon`,
`:due +3d`, `:due 8/14`. Filters compose: `:f tag:dev open crit`.

## Plan vs actual, and the progress line

Every task carries both sides. The plan is `start` + `duration`; the
actuals are stamped as work happens — `actual_start` the first time a
task leaves `todo`, `actual_end` when it is done, both editable if you
are recording things after the fact. Reopening a task clears its finish,
because leaving it would quietly corrupt every comparison downstream.

The gantt draws a **progress line** (イナズマ線) from the reference date:
each row steps left or right by how far it deviates from where the plan
says it should be. Straight means on schedule, a notch left is behind, a
bulge right is ahead. You read the project's health from the shape, not
from a column of numbers.

```sh
:asof 2026-07-20    # the plan as it stood that day
:asof -3d           # three days ago
:asof today         # back to now
```

Progress and status are recorded per day, so a past reference date shows
what was known then rather than today's numbers back-projected. The
recording is one entry per task per day: several edits on one day
collapse to that day's final value, and a day you didn't touch a task
costs nothing. A year of active use is a few megabytes.

Fields that keep no history — titles, dates, the breakdown — are shown
as they are now. That is a real limitation rather than a papered-over
one: the CRDT keeps only the latest value for those, and inventing a
past for them would be worse than admitting there isn't one.

## Working with peers

Each replica prints a ticket at startup, and `:ticket` copies it from
inside the app. Hand it to someone:

```sh
# them
yaiba --join <ticket>
```

That's the whole setup. From then on both sides sync automatically —
immediately on every edit, and on a timer to catch up after being
offline.

**No port forwarding, no inbound firewall rule.** iroh dials by public
key and hole-punches, so outbound UDP is all that's needed. If hole
punching fails the connection falls back to a relay that forwards
already-encrypted QUIC and cannot read what passes through. Peers on the
same network connect directly and never touch it.

The ticket carries a 32-byte room key. A peer that can't present it is
dropped before any data moves.

## How it works

### Edits merge instead of colliding

The data model is a CRDT — a last-writer-wins map keyed by
`(task, field)`, stamped with a [hybrid logical
clock](https://cse.buffalo.edu/tech-reports/2014-04.pdf). Granularity at
the *field* level is what makes concurrent editing feel unremarkable:
if you set a due date while someone else raises the priority of the same
task, both survive. Tags are one entry per tag rather than one array, so
`+dev` and `+ui` added at the same moment both stick. Deletes leave a
tombstone, so a peer that hasn't heard about them can't resurrect the
task on its next sync.

The HLC's node id breaks ties, which means two replicas that receive the
same pair of concurrent writes in opposite orders still land on the same
answer.

Sync is a version-vector exchange: each side says what it has seen, and
only the difference crosses the wire.

### The schedule is computed, never stored

Bar positions come from a forward pass over the dependency DAG (earliest
start, honouring any pinned start date) and a backward pass (latest
start, hence slack). Zero slack means critical path — drawn in magenta.
Blocked, overdue and level are derived the same way, so they can't drift
from the graph they describe.

Cycles are rejected when you create them, but the renderer still
tolerates one: two peers can independently add edges that only close a
loop once merged, so a cyclic graph is a state the UI has to survive
rather than an error it can refuse.

## Development

```sh
cargo make check         # fmt + clippy + test + lock-check — the pre-push gate
cargo make dev           # server against a scratch db
cargo make web-dev       # Vite dev server, /api proxied to the above
cargo make web-build     # rebuild the embedded bundle
cargo make smoke         # release smoke: sqlite, embedded UI, iroh endpoint
```

The SPA lives under `crates/yaiba-server/web/` — inside the crate,
because `rust-embed` bakes `web/dist/` into the binary at compile time.
A release built without `cargo make web-build` still compiles and still
starts; it just serves an empty shell. `cargo make smoke` exists to
catch exactly that.

| crate | what it holds |
|---|---|
| `yaiba-core` | model, CRDT store, dependency scheduling |
| `yaiba-sync` | iroh transport and the sync protocol |
| `yaiba` (in `crates/yaiba-server/`) | HTTP API, embedded SPA, CLI |

The binary crate is named `yaiba` so that `cargo install yaiba` gives you
`yaiba`; its directory keeps the `-server` suffix to say what it holds
next to `-core` and `-sync`.

## License

MIT — see [LICENSE](./LICENSE).
