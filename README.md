<p align="center">
  <img src="https://raw.githubusercontent.com/yukimemi/yaiba/main/assets/logo.svg" alt="yaiba — vim-flavoured todo & gantt, peer to peer" width="620">
</p>

> 刃 — *the blade*. A vim-flavoured todo and gantt planner that runs as a
> single local binary and syncs directly between people. No server to
> host, no account to make.

**Status: released — modal UI, a foldable work breakdown, dependency
scheduling with a critical path, and peer-to-peer replication over
[iroh](https://iroh.computer). `cargo install yaiba`.**

<p align="center">
  <img src="https://raw.githubusercontent.com/yukimemi/yaiba/main/assets/demo.gif" alt="a row opened with o and made to wait for another with D, the date columns filled by walking them, a block of dates yanked onto the actuals, then super mode with strikes flying off the caret and a shockwave on a completion, and the same plan in office mode and in Japanese" width="900">
</p>

<p align="center">
  <sub><code>o</code> opens a row · <code>+</code> lengthens it ·
  <code>D</code> makes it wait for another, and the critical path
  moves to follow · the divider drags · <code>gd</code> puts the dates
  in columns, <code>h</code> <code>l</code> walk them and <code>⏎</code>
  edits one · <code>v</code> <code>y</code> <code>p</code> move a block
  of cells · <code>co</code> hands the row over ·
  <code>zm</code> folds an altitude · <code>gs</code> is super mode —
  the caret throws strikes as you type, a completion sets off a
  shockwave and a delete shakes the screen · <code>gt</code> is office
  mode · <code>:lang ja</code> is the whole UI</sub>
</p>

## Why

Task tools make you choose. Terminal tools are fast to type into but
can't draw a timeline. Web planners draw beautiful gantt charts and then
ask you to reach for the mouse — and to put your plans on someone else's
server.

`yaiba` refuses the choice:

- **The keyboard is the interface.** Modal editing, `:` commands,
  operators that wait for a motion. `o` opens a row and you type;
  `space` completes it; `dd` deletes and `u` brings it back.
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

To put your build on `PATH` instead of running it out of `target/`:

```sh
cargo make install           # or: makers install
```

Both go through the web bundle first. Plain `cargo install --path .`
does not, and the UI is baked in by `rust-embed` at compile time — a
missing bundle installs an empty one silently rather than failing.

The browser opens on `http://localhost:8188`. The database lives in your
platform data directory (`--db` to move it).

```sh
yaiba --port 9000            # somewhere else
yaiba --no-open              # don't launch a browser
yaiba --no-sync              # fully local, no peer endpoint at all
yaiba --relay-only           # sync without binding a UDP socket — no firewall prompt
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
| `i` `I` `a` `A` `cc` | edit the cell under the cursor — on the title, at the head / tail / cleared |
| `space` | complete (the row gets cut) · `s` cycles todo → doing → done |
| `x` | clear the cell under the cursor · `dl` is vim's spelling of it |
| `dd` `yy` `Y` | delete, yank rows |
| `p` `P` | put the last yank · `P` is rows only · `u` / `^r` undo, redo |
| `J` `K` | move the row down / up, changing level to suit where it lands |
| `+` `-` | duration ±1 day · `.` `,` start ±1 day · `gp` `gP` priority · `(` `)` progress |
| `D` | add a dependency: pick the task this one waits for, `⏎` |
| `X` | cut a dependency |
| `v` `V` | select cells / whole rows — every edit above applies to the block |
| `/` `n` `N` | search |
| `tab` | split → list → gantt · `[` `]` zoom the timeline |
| `gd` | plan-vs-actual date columns ⇄ compact |
| `cs` `ce` `ca` `cA` | calendar on the planned start / end, actual start / end |
| `co` | hand the row over — the panel lists the names already in use |
| `gt` | office mode ⇄ neon · `:theme` and `:lang` say it by name |
| `gs` | super mode ⇄ neon — every effect at maximum · `:super` |
| `h` `l` | out / in — a fold, or a cell once `gd` is up · `⏎` `i` `I` `a` `A` `cc` edit it |
| `>>` `<<` | nest under the row above / move back out |
| `zm` `zr` | fold one level shallower / deeper · `zM` `zR` all the way |
| `za` | fold this row · `zf` focus its subtree, `zF` to come back |

## Three modes, and a mouse

`yaiba` ships a second theme for the times a neon HUD is the wrong
thing to have open — a meeting room, a shared screen, a status deck.
Office mode drops the glow, the scanlines and the completion sweep
entirely, and swaps cyan/magenta for the blue/red/amber a reader already
knows from every other planning tool. It prints.

```text
gt              office mode <-> neon mode
:theme light    or by name
```

And a third for the opposite occasion. **Super mode** is the same HUD
with nothing held back: the glow multiplier goes up, an aurora drifts
behind the plan, a CRT band rolls down the screen, the wordmark flickers
like a sign, the cursor row catches the light, the critical path marches,
and every stroke the blade draws is answered by the whole screen — a
shockwave on a completion, a shake on a delete.

Typing draws too. Every character throws short strikes off the caret and
puts a small recoil through the shell, a run of them keeps a count, and
the count makes both louder — the power-mode gag with a blade in place
of the sparks. It follows the caret through anything you can type into:
a task title, the `:` line, search, the project palette. Japanese draws
kana by kana as the reading is typed, and the 変換 that commits it lands
heavier than a single key.

```text
gs              super mode <-> neon mode
:super          bare toggles · :super on / :super off
:theme super    or by name
```

It is one axis, not a switch beside the theme: `gt` takes you out of
super the same way it takes you out of neon, because office mode is
somewhere you go *to* and it wins. Two things survive being turned up
this far — the palette rule, so magenta still means the critical path
and nothing else, and `prefers-reduced-motion`, which turns the whole
mode's motion off and leaves nothing frozen on screen.

The choice is remembered, and a fresh install follows your OS
preference.

The UI has a language too, and that one starts in English:

```text
:lang ja        日本語で表示します
:lang en        back to English (bare :lang toggles)
```

It is the whole surface, not a veneer: the `?` panel, the status line's
replies, every refusal the `:` line can give you, the column heads and
the project palette. English is the default rather than your browser's
locale, because a screenshot of `yaiba` should read the same wherever it
is opened; `ja` is a choice, and it is remembered. Both toggles sit at
the right of the top bar for a mouse.

What is *not* translated is anything you type. Key names, command names,
`todo` / `doing` / `done`, tag names and the words a command accepts
(`day, week, month`) read the same in either language — a help that
renamed the keys would be describing a different program from the one
under your fingers.

The keyboard remains the point, but every common action has a mouse
equivalent, because handing the screen to someone else should not
require handing over the keybindings too:

| | |
|---|---|
| click a row | put the cursor on it |
| right-click a row or its bar | the menu of what nothing else here reaches |
| `⇧` right-click | the browser's own menu, untouched |
| click the `+` on it | a new task below, at the same level — what `o` does |
| click `[ ]` | complete / reopen |
| click `▾` | fold a summary |
| double-click | edit the title |
| click the owner cell | pick who it belongs to (`gd` shows the column) |
| drag a row | reorder — a line shows the slot, indented to the level it lands at |
| drag a bar | move its start date |
| drag its right edge | change the duration |
| drag the dot past its end onto another bar | make that task wait for this one |
| click a date cell | pick that date off a calendar (`gd` shows the columns) |
| `◀` `▶` beside the date | move the reference date a day |
| click the date | jump to one, or back to now |
| drag the divider | give the list more of the width, or less |

That table used to have a hole in it, and the hole was the shape of a
rule this project keeps in the other direction: *nothing should be
reachable only by clicking*. Deleting a row was reachable only by
typing. So were its priority, its progress, its nesting, its note — and
`doing`, which is the one a status meeting is actually about, since
`[ ]` only ever toggles the two ends of `todo → doing → done`.

Right-click fills it. What is on the menu is decided by a rule rather
than by taste — **an item is there exactly when the mouse cannot already
reach it, and every item names the key it runs**:

```text
⚑  mark it doing                       s
◆  priority                    ▲ gp ▼ gP
%  progress                     + ) − (
✎  note…                           :note
⇥  nest / unnest               → >> ← <<
⌖  focus this subtree                 zf
✂  yank the row                       yy
⎘  put it below                        p
↶  undo                                u
✖  delete the row                     dd
```

Both halves of the rule are load-bearing. The first keeps the menu from
becoming fifteen items nobody reads, and shrinks it on its own: add a
direct gesture for something and its entry leaves, which
`check-rowmenu.ts` asserts against the list of gestures rather than
leaving to memory. The second makes the menu teach — you right-click to
delete a row and the menu tells you it was `dd` all along, so the mouse
path advertises the keyboard one instead of competing with it.

It is also the one panel here with no keyboard opener, and for the same
reason: `co` had to have one because it lists the names already in use,
which is something no key can tell you, and this lists keys, which `?`
already does. Nothing is behind a click that is not also behind a
keystroke — that is the point, not an exception to it.

Deleting from the menu asks nothing first. `dd` does not either, `u`
brings the row back — drawing it back, since an undo now replays the
stroke its own ops describe: a restored task is born again, and a task
an undone `o` takes away is cut down first — and right-click → move →
click is already two acts of intent; the status line says what went.

`⇧` and right-click declines the event and you get the browser's menu,
because there is no API that *opens* it — declining is the only offer a
page can make. Only rows and bars take the button at all, so anywhere
else it was never ours.

The divider between the list and the timeline is draggable — the line you
see is the thing you grab, with a few pixels either side so it is
catchable. Double-click puts it back to the default. The width is
remembered like the theme is, so it survives a reload, and `:split 40`
sets it by number for anyone who would rather not aim. Grabbing it also
leaves it holding the keyboard, so `←` and `→` — or `h` and `l` — move it
2% at a time, and `Home` puts it back. That the mouse is what hands it the
keyboard is not an oversight: `tab` is spoken for by the layout cycle, so
there is no keying your way over to the divider without touching it first.
Neither side can be dragged below 15%: a pane squeezed to nothing reads as
a bug, and there is no grip left to pull it back by. `tab` is how you
actually hide one.

Dragging a bar pins its start: a task placed by its dependencies gets an
explicit date, which is what makes the gesture survive the next
recompute. Summary bars cannot be dragged — their dates are a
consequence of what is inside them.

The `+` shows on the cursor row only. On every row it is a column of plus
signs and the eye stops reading the tasks; and the row it sits on is the
one whose level the new task inherits, so the indent it will land at is
the indent you are looking at. An empty project has no row to hover, so
there the prompt itself — *o to open a new task* — is the button.

The owner panel is the mouse's way to a field the command line reached
first, and it lists the names already in use rather than offering a bare
box. That list is the only thing keeping a team to one spelling, since
there is no roster behind the names: `tab` does that job on the `:` line,
and clicking has no `tab`. `co` opens the same panel from the keyboard —
nothing in yaiba should be reachable *only* by clicking.

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

You can still link a summary, and it means what it looks like: an edge
*onto* one holds back everything inside it, and an edge *out of* one waits
for the whole bracket to close — the last child, not the first. Under the
hood the edge is rewritten to run between the leaves, since those are the
rows that carry dates. The one pairing that is refused is a summary and
something inside it, which would ask a task to finish before itself.

An edge carries how long after its predecessor the successor may start,
and `:dep ⟨row⟩ +⟨days⟩` is where you say it:

```text
:dep 3        row 3 finishes, this one starts the next day — the default
:dep 3 +0     row 3 finishes, this one may start the same day
:dep 3 +5     five days after, for parts arriving or paint drying
```

`+0` is the one worth knowing about. Two half-day jobs done in one
sitting are a real shape, and until an edge could say so the second one
was always pushed to tomorrow. Re-running `:dep` on an edge that
already exists is how its spacing changes; there is no need to unlink
first.

You rarely have to, though. A pinned start is a floor to the scheduler,
and a pin dropped inside an edge's lag — by dragging the bar onto its
predecessor's day, by `:start`, from the calendar, by a pasted cell, or
with `.` / `,` — adjusts the lag to the spacing the date implies, in
the same commit, and says so on the status line. A pin before the
predecessor's finish would invert the edge, and is refused with the
date it does finish.

The default stays at one day, so no existing plan moves. A negative lag
is refused rather than clamped quietly: it would mean the two *overlap*,
which "A finishes before B starts" cannot carry — that would want a
different kind of edge, not a smaller number.

`blocked` still means "a predecessor is not done", not "not today". A
same-day successor is drawn alongside its predecessor and is still
blocked, because the edge is about order rather than dates — a task
waiting on unfinished work should not stop saying so just because the
scheduler placed it conveniently.

Commands take dates the way you'd say them: `:due tom`, `:due mon`,
`:due +3d`, `:due 8/14`. Filters compose: `:f tag:dev open crit`, and
`:f late` is the one that answers "what has actually slipped" — every
row whose finish has gone by with the box still unchecked, due date or
no due date.

`tab` completes on the `:` line, wildmenu and all: the command name
first, then that command's own vocabulary — `:sort` its keys, `:tag` the
tags already in use, `:assign` the people already on something, `:due`
the words above. `shift-tab` walks back, and either one past the end of
the list returns what you had typed.

## Who owns what

One person per task. In the working view it rides the row as `@name`,
next to the tags; switch to the date columns with `gd` and it becomes an
`owner` column instead — fixed width, so a roster reads straight down the
page. The chip keeps "whose is this" answerable without a mode change;
the column is what a progress meeting scans. Never both at once, which
would be the same name twice on one row.

```
:assign yuki      hand it over — the visual block, if one is selected
:assign           and bare takes it back (`none` / `-` read the same)
:f @yuki          just theirs
:f unassigned     the rows nobody has picked up
:sort owner       one person's work in a block, unowned last
```

There is no user table behind the name and there deliberately isn't
one: inventing a roster would mean every replica agreeing on it before
anybody could be assigned anything. So the people who exist are exactly
the people already on something, which is what `tab` completes from —
and completing rather than retyping is the only thing keeping `Yuki` and
`yuki` from becoming two names in a report nobody notices are one
person. Matching ignores case regardless; the spelling you typed is the
one that is stored, because with no registry it is the only record of
how somebody writes their own name.

Unlike tags, the owner is a single last-writer-wins field: two peers
naming different people converge on the later write rather than both
sticking, and every replica picks the same one. The loser's name is
gone, not merged — which is the point. A task never ends up with two
owners, and it only ends up with none if clearing it is what won.

A name is one word, the way a tag is: the filter grammar is
space-separated, so `mary jane` would be two terms and match neither.
`:assign` says so rather than storing something you cannot then find.

## Plan vs actual, and the progress line

Every task carries both sides. The plan is `start` + `duration`; the
actuals are stamped as work happens — `actual_start` the first time a
task leaves `todo`, `actual_end` when it is done. Reopening a task
clears its finish, because leaving it would quietly corrupt every
comparison downstream.

```sh
:start mon      # the plan: where it begins…
:dur 5          # …and how long it takes
:end 8/20       # or say where it lands, and the duration follows
:astart 8/18    # the actuals, when you are recording after the fact
:aend 8/22      # `none` on either one clears it
```

The two sides are shaped differently on purpose. A plan is `start` +
`duration` because the scheduler *moves* it: when a dependency slips,
what stays true is how long the work takes, not the day it happens to
finish. So there is no stored end date — `:end` is sugar that measures
back from the date you name and writes the duration. An actual span is
the opposite: both ends are recorded, because nothing recomputes what
already happened, and the days between them are not "how long it took"
anyway.

The gantt draws each recorded span as a thin rail under the bar, so the
offset between plan and actual reads without a legend — flush left
started on time, a rail past the bar's right edge ran long. Work still
in progress fades out at the reference date rather than claiming a
finish it doesn't have.

When the four dates are the point — a progress meeting, a status sheet
someone else fills in — the list will show them as columns instead of
its markers:

```text
gd              date columns <-> compact
:dates          the same toggle by name · :cols compact
```

| | |
|---|---|
| `start` `end` | the plan · dim means the scheduler placed it, not you |
| `began` `ended` | the record, quieter, behind a rule |

A task you have not pinned starts **today** — or at the reference date,
when `:asof` has moved it — and then as late as its predecessors force.
The floor is a default, not a clamp: `:start` on a past date is a
statement and is kept. It applies to a task with predecessors too, so a
chain whose earlier links finished last month does not lay the rest of
itself out behind you. What actually happened belongs in `began` /
`ended`; the plan is for work still ahead.

> Upgrading to 0.12 moves rows, once. Before it, an unpinned task sat at
> the *oldest* date anywhere in the plan, so on a project with history
> every one of them will jump forward on first load. Nothing is written
> and no `start` appears — they were never pinned and still are not; the
> scheduler has simply stopped answering "when can this be done" with
> "whenever the project began".

Click a cell and a calendar opens over it — `hjkl` or the arrows walk
the grid, `[` `]` page months, `t` jumps to the reference date, `x`
clears, `⏎` commits. The keyboard opens the same panel on the cursor
row, without reaching for the mouse or turning the columns on:

```text
cs              calendar on the planned start · ce on the end
ca              calendar on the actual start · cA on the actual end
```

`c` is change, the way `cc` changes the title. Every pick runs the
command you could have typed, so it obeys the same rules: picking an
`end` writes a duration, an actual span is refused if it would run
backwards, and a summary's plan is not editable at all — those cells are
plain text rather than buttons, and `cs` on one says so.

Those five keys each name one field, which is what you want when you are
somewhere else in the plan and just need to fix a date. Filling a column
in is the other job, and for that the cursor walks:

```text
h l             out / in — the cell to the left, the cell to the right
j k             the next row, still in this column
⏎               edit the cell you are standing in
```

`h` and `l` mean one step out and one step in, and a cell is a smaller
step than a subtree — so at the leftmost cell, where there is no cell
further out, they are the fold's again. That is the whole rule. In the
compact view there is one column, so they only ever fold, which is what
they did before the columns existed.

Standing still in a column while `j` walks down the page is the point:
`⏎`, pick, `j`, `⏎`, pick — a roster or a set of planned starts, filled
straight down without the mouse and without retyping a command per row.

Or copy what is already there. `v` selects a rectangle of cells rather
than a run of rows, so the shape you take is the shape you put down:

```text
v j j y         one column, three rows
v l j y         two columns, two rows
p               put it down with the cursor on its top-left corner
```

It lands by offset, not by column name — that is what makes yanking
`start` `end` and dropping it on `began` `ended` the two keystrokes it
should be, which is the comparison the columns exist for. A column whose
kind disagrees does not land: a date will not overwrite a title, and the
status line says which cells it skipped rather than half-writing the
block and looking like it wrote all of it. Running off the last column
or the last row reads the same way.

Every cell is written by running the command you could have typed, so
the rules do not move: `end` is a duration measured back from the start,
so pasting one onto a row that starts elsewhere changes its length; an
actual span that would finish before it began is refused; a summary's
plan cells are refused. And a `start` the scheduler placed for you looks
the same as one you pinned — copying it pins it on the row it lands on.

`V` takes whole rows instead, which is the selection `v` used to be.
Rows and cells are two registers and two kinds of put: `yy` / `Y` yank
rows and `p` makes copies of them, `y` yanks cells and `p` writes them
over what is there. `p` puts down whichever you filled last.

`P` is the exception: it only ever puts rows. A row block makes room
above the cursor, which is what "before" means for a row; a cell block
overwrites the cells you point it at, and there is no above to land on.

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

The reference date sits in the top bar at all times — it is the number
every bar, percentage and overdue flag is measured from, so leaving it
unstated made the view depend on something it never showed. `◀` and `▶`
walk it a day at a time, which is how you watch the progress line bend;
clicking the date opens a jump list and a date field. It reads as grey
chrome while you are at now and turns amber the moment you are not,
because moving off now is a mode, and one that refuses edits.

Forward is as available as back: a date ahead of now answers "if nothing
moves, how far behind is this by Friday". What a past date will *not*
show you is a task that did not exist yet — the snapshot drops anything
created after the date, so a task entered today is absent from
yesterday's view even when its planned dates run back a fortnight. The
filter is on when the task was written down, not on where its bar sits.

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
yaiba join <ticket>
```

That's the whole setup. From then on both sides sync automatically —
immediately on every edit, and on a timer to catch up after being
offline.

Their tasks arrive as a **project of their own** — a separate database,
listed under a name you can pick with `--as` — so joining someone never
mixes their backlog into yours. See [Projects](#projects).

**No port forwarding, no inbound firewall rule.** iroh dials by public
key and hole-punches, so outbound UDP is all that's needed. If hole
punching fails the connection falls back to a relay that forwards
already-encrypted QUIC and cannot read what passes through. Peers on the
same network connect directly and never touch it.

Hole punching does bind a UDP socket on every interface, and Windows
greets that with a firewall prompt — which on a locked-down machine asks
for an administrator who isn't you, and comes back on every start.
`--relay-only` binds no UDP socket at all:

```sh
yaiba --relay-only            # sync over the relay, no UDP socket of our own
YAIBA_RELAY_ONLY=1 yaiba      # same, permanently, from the environment
```

The UI's listener is unaffected — it is on loopback, which no firewall
asks about, and that is true in either mode. Everything still syncs and
the ticket is unchanged: a peer dials your public key and never learns
which path answered. What you give up is the direct connection, so it is
slower and it needs the relay to be reachable.

The ticket carries a 32-byte room key. A peer that can't present it is
dropped before any data moves.

## Projects

A `yaiba` database is one task set, one sync room, one identity — nothing
in the replication layer scopes tasks to a project *inside* a database. So
a project **is** a database file, and `yaiba` keeps an index of them.

```sh
yaiba                          # the default project
yaiba new private              # start one of your own, and open it
yaiba list                     # what's registered, most recent first
yaiba open work                # open one by name
yaiba open                     # fuzzy-pick one
yaiba join <ticket> --as work  # join a peer as a new project, and open it
yaiba forget work              # drop the name; the database stays on disk
```

Keeping apart what should be apart is what `new` is for — a backlog you
share with someone, and one you don't:

```sh
yaiba new shared               # hand this one's ticket out
yaiba new private              # never share this one, and nobody can reach it
```

Nothing leaves a project until you hand out *its* ticket. Each has its own
database, its own sync room and its own identity, so sharing one says
nothing about the others.

Whatever you open is registered as you go, `--db` paths included, so the
picker fills itself in without any setup step. Your default database is
adopted the moment it exists, so `yaiba list` and the picker already know
about it before you have opened anything. The index is a TOML file meant
to survive being hand-edited:

| path | |
| --- | --- |
| `<data dir>/yaiba/projects.toml` | the index |
| `<data dir>/yaiba/yaiba.db` | the default project |
| `<data dir>/yaiba/projects/<name>.db` | projects you joined |

`YAIBA_DATA_DIR` moves that whole root — one variable for a
self-contained yaiba on a synced folder or a stick.

Losing the index costs names and ordering, never tasks: every database
still opens with `yaiba --db <path>`, registered or not.

**One yaiba holds them all.** Starting it opens every registered project,
not only the one you asked for, and each one replicates on its own —
so a project is up to date when you turn to it, rather than starting to
catch up at that moment. There is no second process and no second port.

Manage them from inside the app, without restarting. **`:proj`** opens a
fuzzy picker over what is open — and so does clicking the project name in
the top bar, which is the way in for a mouse.

| in the picker | |
| --- | --- |
| `^n` / `^p` | move |
| enter | switch |
| `^r` | rename the row under the cursor |
| `^d` | forget it — asks first |
| type a name nothing matches | offers to create it |

`rename` and `forget` are buttons on that row too. From the command line:
`:proj <name>` switches, and `:proj new <name>`, `:proj rename <name>`
(renames the one you are on) and `:proj forget <name>` do the rest, with
`<tab>` completing names.

**Forget only drops it from the list** — the database stays where it is,
which is what the picker says before it does anything.

A registry entry whose database has gone is skipped with a warning rather
than stopping the launch. If opening everything costs more than it is
worth — a long registry, a slow disk, a metered link — `--only-active`
opens just the one project.

### `--join` is not `join`

The `--join <ticket>` *flag* predates projects and still does what it
always did: it **merges the project you are opening into the peer's
group**. Both task sets end up on both sides, and this replica leaves its
own sync room for theirs. That move has no undo — the old room key is
overwritten, so anyone holding your previous ticket is dropped on their
next sync.

The `join` *subcommand* is what you almost always want. The flag stays for
the case it is actually right for: deliberately fusing two replicas that
should have been one all along. `:join` in the UI is the flag's
behaviour, not the subcommand's — one running server has one database.

## Letting an agent read and edit the plan

`yaiba mcp` serves the plan over [MCP](https://modelcontextprotocol.io),
so a coding agent can answer "what's blocking the release?" and break a
task down without you retyping any of it. It talks to a yaiba that is
**already running**, so leave one up and register the server once:

```sh
yaiba                              # in one window, and leave it
claude mcp add yaiba -- yaiba mcp  # once
```

Point it elsewhere with `yaiba mcp --url http://127.0.0.1:9000`, or
`YAIBA_MCP_URL`. It must be `http://` — this dials your own machine and
is built without TLS.

Eight tools: `plan` reads everything (computed dates, critical path,
what's blocked, what's overdue); `add_task`, `update_task`,
`delete_task`, `link` and `unlink` edit it; `projects` and
`switch_project` move between plans. Tasks are named by title or by the
short id `plan` prints — an ambiguous name is an error listing the
candidates rather than a guess.

**The agent is a client like any other.** It goes through the same HTTP
API the UI does, so every rule holds without being restated: a
dependency that would close a loop is refused, a summary's dates still
come from its children, and a pinned start is still a floor. Every write
answers with where the plan then stands, which is usually the point —
cutting one dependency can move the finish date a week.

There is no authentication on the API, and the MCP server is a local
process talking to `127.0.0.1`. Keep it that way.

## How it works

### Edits merge instead of colliding

The data model is a CRDT — a last-writer-wins map keyed by
`(task, field)`, stamped with a [hybrid logical
clock](https://cse.buffalo.edu/tech-reports/2014-04.pdf). Granularity at
the *field* level is what makes concurrent editing feel unremarkable:
if you set a due date while someone else raises the priority of the same
task, both survive. Tags are one entry per tag rather than one array, so
`+dev` and `+ui` added at the same moment both stick — where the
assignee is a single entry precisely so two people naming different
owners *don't* both stick. Deletes leave a
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
Blocked, overdue, late and level are derived the same way, so they can't
drift from the graph they describe.

The last two answer different questions and a plan usually has more of
the second. **Overdue** is the plan overrunning a date somebody typed:
it needs a due date, and it compares two *planned* dates. **Late** is
the ordinary case — the computed finish has gone by and the box is
still unchecked — so it needs no due date at all, it is measured
against the reference date and moves with `:asof`, and a summary is
late whenever anything inside it is, which is what keeps a folded
branch from hiding it. Both draw amber, on the row's title and on its
bar; `:f late` filters to them and the HUD counts them beside `crit`.

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
