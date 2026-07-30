<!-- kata:agents:base:begin -->
## Shared conventions

This file is the agent-agnostic source of truth (per the
[agents.md](https://agents.md) convention). The matching
`CLAUDE.md` and `GEMINI.md` files are thin shims that point back
here so each tool's auto-load behaviour still finds something.
**Edit AGENTS.md, not the shims.**

### Git workflow

- **No direct push to `main`.** Open a PR.
  - Exception: trivial typo / whitespace / docs wording fixes.
- Branch names: `feat/...`, `fix/...`, `chore/...`.
- **PR titles + bodies in English. Commit messages in English.**
- **Releases are PR-driven, tagging is automatic.** Bump
  `[workspace.package].version` (workspace) or `[package].version`
  (single crate) in a `chore/release-vX.Y.Z` PR. On merge to `main`,
  `.github/workflows/auto-tag.yml` (kata-managed) detects the bump,
  pushes the `vX.Y.Z` tag, and that tag fires `release.yml` for
  binary builds + crates.io publish. **Do not run `git tag` by
  hand** — the bot tag will collide and the manual push fails.

### PR review cycle

- Every PR runs reviews from **Claude Code**
  (`.github/workflows/claude-review.yml`, kata-managed) and
  **CodeRabbit**. Wait for both bots to post, address their
  comments (push fixes to the PR branch), and merge only after
  feedback is resolved. The claude-review workflow skips
  review-exempt PRs by itself (its job-level `if:` excludes
  `chore/release-*`, `kata-apply/auto`, `apm-bump/auto`, and
  Renovate / Dependabot authors) — a missing Claude review on
  those PRs is expected, not a failure.
- **Any PR that touches the Claude workflow files goes
  unreviewed.** `claude-code-action` requires the workflow file to
  already exist on the default branch **with identical content** —
  otherwise a PR could rewrite the workflow to exfiltrate the
  token. When the content differs it logs "Skipping action due to
  workflow validation" and exits 0 without reviewing: a green
  check with no review attached. This covers two cases, and the
  second is the one that keeps surprising people:
  - the PR that first adopts these templates (the workflow does
    not exist on the default branch yet), and
  - any later PR that **edits** `claude-review.yml` / `claude.yml`,
    e.g. hand-pulling an upstream template fix.

  Not fixable from this side — it is the mechanism that makes the
  token safe to hand to the action at all. Expected: merge on CI +
  owner approval; reviews resume on the next PR that leaves the
  workflows alone. The `kata-apply/auto` branch is already excluded
  by the job-level `if:`, so the daily template-refresh PRs do not
  add noise here.
- **A missing credential fails loudly instead.** If the repo has
  neither `CLAUDE_CODE_OAUTH_TOKEN` nor `ANTHROPIC_API_KEY` set,
  the guard step fails the job — set one and re-run (subscription
  path: `claude setup-token` → `gh secret set`; pay-as-you-go:
  store `ANTHROPIC_API_KEY` and swap the action input to
  `anthropic_api_key`). Distinguishing the two: **red** means no
  credential, **green with no review** means workflow validation.
- **The Claude full review fires once, at PR open** (plus
  `ready_for_review` / `reopened`) — fix pushes do **not** re-trigger
  it (`synchronize` is deliberately off the trigger list; a full
  re-review per push doubled up with the mention-driven re-check
  below and burned tokens for no extra signal). Verification of
  fixes rides the `@claude` thread replies. After a large rework
  that changes the PR's shape, request a fresh full pass
  explicitly: `@claude please re-review the full PR`. CodeRabbit
  still reviews pushes on its own cadence (its app config, not
  this workflow).
- **After opening a PR, immediately enter the review-monitoring
  loop — do not ask the user whether to start it.** Drive the
  cadence with `/loop` — fixed-interval mode (e.g.
  `/loop 60s …`) schedules ticks via `CronCreate`; dynamic mode
  (no interval, `/loop …`) self-paces via `ScheduleWakeup`. The
  agent actively pulls fresh state each tick with
  `gh pr view <N> --json state,reviews,comments,statusCheckRollup`
  and `gh api repos/<owner>/<repo>/pulls/<N>/comments` (the
  latter covers inline review comments, which `gh pr view`
  does not surface) and reacts to new bot feedback. Passive
  watchers (background `gh` polls, file watchers, hooks) cannot
  trigger active follow-up, so they are not a substitute —
  without an active wake-up the agent never re-reads the PR.
- **Default polling interval: 60s.** Claude Code review /
  CodeRabbit typically reply within ~1–5 minutes of a push or
  thread reply, so a 60s tick catches them on the next wake-up
  without burning cache: 60s sits well inside the 5-minute
  prompt-cache TTL, so the conversation context stays cached
  across ticks. Do **not** stretch the interval to 300s — that
  is the worst-of-both window (you pay the cache miss without
  amortizing it). If the PR is idle but a bot re-review is still
  expected (e.g. a CodeRabbit rate-limit refill window), step
  **up** to 1200–1800s instead.
- **Stop the loop entirely when only owner approval is missing.**
  Once review bots are quiet (or quiet-by-exception — version-bump
  skip, Renovate/Dependabot skip), CI is green, and there is no
  other expected follow-up, the *only* remaining action is human
  approval. GitHub already notifies the owner; the agent
  re-entering on every cron tick to find the same "still waiting
  on owner" state burns cache and adds no value. Stop scheduling
  further wake-ups (`CronDelete` in fixed-interval mode; simply
  omit the next `ScheduleWakeup` in dynamic mode) and report the
  wait state to the user. The owner restarts the loop after their
  next push if a fresh bot pass is wanted, or merges directly.
  (A CodeRabbit rate-limit window doesn't qualify on its own — a
  re-review is still expected once the quota refills, so step up
  to 1200–1800s instead and let it ride. Stopping is only correct
  when the owner has explicitly chosen to skip the bot pass per
  the rate-limit exception below.)
- **Reply to reviewers after pushing a fix — in each thread, not
  at the top level.** Every finding lives in its own inline review
  thread; answer *each* one as an in-thread reply, carrying an
  **@-mention** (`@claude` / `@coderabbitai`). Use the review-
  comment *replies* endpoint — `gh api repos/<owner>/<repo>/pulls/<N>/comments/<comment_id>/replies -f body=…`
  (or `-F in_reply_to=<comment_id> -f body=…` on the comments
  endpoint — `body` is required there too) — and
  get each comment's `<comment_id>` from
  `gh api repos/<owner>/<repo>/pulls/<N>/comments`. A single
  top-level `gh pr comment` does **not** count: it leaves every
  inline thread unresolved, the bot can't tie your response to the
  finding it raised, and the per-finding audit trail is lost.
  Reply in-thread even when you're **declining** a suggestion —
  say why; a silent skip reads as overlooked. Note `@claude` also
  triggers the interactive responder
  (`.github/workflows/claude.yml`, kata-managed) — it will
  re-check the fix and reply on the thread. Since fix pushes no
  longer re-trigger the full review, this mention-driven re-check
  is the **only** Claude-side verification of a fix — don't skip
  it for substantive fixes; do skip it for pure FYI notes that
  need no verification.
- A review thread is **settled** the moment the latest bot reply
  is ack-only ("Thank you" / "Understood" / a re-review summary
  with no new findings) or 30 minutes elapse with no actionable
  comment.
- **Merge gate**: review bots quiet AND owner explicit approval.
- Bot-authored PRs (Renovate / Dependabot) skip the bot-review
  gate; CI green + owner approval is enough.
- **Version-bump-only PRs** (a single `chore/release-vX.Y.Z`
  branch whose entire diff is `[workspace.package].version` /
  `[package].version` + the matching inter-crate refs +
  `Cargo.lock`) **also skip the bot-review gate.** There is
  nothing for the bots to find in a version bump, and the
  release pipeline downstream of merge (auto-tag → release.yml)
  is time-sensitive. CI green + owner approval is enough.
- **Treat CodeRabbit rate-limit notices as "quiet" for the
  merge gate.** If CodeRabbit only posts a "Review limit
  reached" quota-exhaustion message (no findings, no inline
  comments), it has produced no review content — there is
  nothing to address. Re-trigger with `@coderabbitai review`
  once the quota refills if you want a real pass; for small or
  time-sensitive PRs, merge on owner approval without waiting.

### Worktree workflow

> **Before your FIRST edit to any file, run `renri add` — NEVER edit the
> main checkout.** Read-only inspection (Read / Grep / Glob) stays on the
> main checkout; the instant you intend to *change* a file, you must
> already be in a worktree. The trap that keeps catching agents: diving
> into a fix the moment the diagnosis lands and editing in place. A
> concurrent agent shares the main checkout — your in-place edits will
> clobber theirs or be clobbered, and in a jj-colocated repo a stray
> working-copy commit entangles unrelated WIP into your branch. If you
> slip and edit in the main checkout, capture the diff first (jj already
> snapshotted it into the working-copy commit, so `jj diff > patch`; for
> git, `git stash` or save a patch — if you got as far as committing on a
> branch, just push it). Then reset the main checkout to pristine main
> (`jj new main@origin`, or `git switch -`), `renri add` a worktree, and
> re-apply the captured diff there.

Use [`renri`](https://github.com/yukimemi/renri) for any
commit-bound change. From the main checkout:

```sh
renri add <branch-name> --from main@origin            # create a worktree (jj-first), off latest upstream main
renri --vcs git add <branch-name> --from origin/main  # force a git worktree, off latest upstream main
renri remove <branch-name> -y --non-interactive  # cleanup after merge (agent-safe; see note)
renri prune                        # GC stale worktrees
```

Read-only inspection can stay on the main checkout.

**Always pass `--from <upstream main>`** (`main@origin` for jj,
`origin/main` for git). Without it, `renri add` forks off the *cwd
worktree's current HEAD* — in a long-lived main checkout that often
lags upstream, so the PR later shows up CONFLICTING against a `main`
that had already moved (e.g. a refactor merged upstream before the
branch was cut), forcing a manual re-port of the whole change.
`renri add` does fetch first, but fetching only updates `main@origin`
— it never moves the checkout's HEAD, so an explicit `--from` is what
guarantees a fresh base.

**Agents / non-interactive shells:** `renri remove` prints a details
panel and waits for a confirmation prompt — without `-y` it **hangs**,
and `--non-interactive` *alone* errors asking for `-y`. Always pass
`-y`, and add `--non-interactive` so a mistyped/omitted name fails
instead of opening a fuzzy picker (the same picker-fallback applies to
`remove` / `cd` / `exec` with no name). Use `-f`/`--force` to remove a
worktree that still has uncommitted changes or conflicts. To sweep
every merged-PR worktree in one shot: `renri remove --merged -y`.

### kata-managed sections

Several files in this repo are managed by `kata apply` from the
[`yukimemi/pj-presets`](https://github.com/yukimemi/pj-presets)
templates — the bytes between `<!-- kata:*:begin -->` and
`<!-- kata:*:end -->` markers, plus the overwrite-always files
listed in `.kata/applied.toml`. **Editing those bytes locally
won't survive the next `kata apply`** — push the change to the
upstream template repo (`yukimemi/pj-base` / `yukimemi/pj-rust` /
…) instead. The marker scopes are layered:

- `kata:agents:base:*` — language-agnostic conventions (this section).
- `kata:agents:rust:*` — added when `pj-rust` applies.
- `kata:agents:rust-cli:*` — added when `pj-rust-cli` applies.
<!-- kata:agents:base:end -->
<!-- kata:agents:rust:begin -->
### Rust workflow

This repo follows the shared Rust toolchain conventions. The
language-agnostic conventions block above (`kata:agents:base:*`)
covers git workflow, PR review cycle, and worktree usage.

### Build / lint / test

```sh
cargo make check                    # fmt --check + clippy + test + lock-check (the pre-push gate)
cargo make setup                    # one-time hook install + apm install
cargo build                         # debug build
cargo build --release               # release build
cargo test                          # tests; add -- --nocapture for stdout
```

`cargo make check` is what `.github/workflows/ci.yml` runs and what
the local pre-push hook calls — anything that passes locally
should pass on CI and vice versa. Don't paper over a failing
clippy by sprinkling `#[allow(clippy::...)]`; fix the underlying
issue or push back on the lint with reasoning.

### Toolchain pin

The Rust toolchain is pinned via `rust-toolchain.toml` and the
project compiles with the `stable` channel. Don't introduce
nightly-only features without a real reason; if you do, document
the reason in the relevant module.

### Lint / format policy

`rustfmt.toml` and `clippy.toml` are kata-managed (sourced from
`yukimemi/pj-rust`). Edits to those files in this repo won't
survive the next `kata apply`; if a setting is wrong, push the
fix to `yukimemi/pj-rust` so every Rust project using these templates picks
it up.

### CI workflow

`.github/workflows/ci.yml` is also kata-managed. The source lives
in `yukimemi/pj-rust/.github/workflows/ci.yml.template` (the
`.template` suffix keeps GitHub Actions from running the source
itself in pj-rust); each Rust project receives the rendered
`ci.yml` via `kata apply`. Action versions are bumped centrally
by Renovate at `yukimemi/pj-rust` and propagate down on the next
apply, so don't bump them locally — Renovate is configured
(via the kata-distributed `renovate.json`) to ignore
`.github/workflows/ci.yml` and `.github/workflows/release.yml`
in each PJ to avoid the bump→clobber loop.

### Releasing: version bump PR + auto-tag

Releases are triggered from `main` by a Cargo.toml version
change. `.github/workflows/auto-tag.yml` is kata-managed (source:
`yukimemi/pj-rust/.github/workflows/auto-tag.yml.tera`). It
watches `main` and, whenever a commit lands that changes the
top-level `version = "..."` in `Cargo.toml`, it pushes a matching
`vX.Y.Z` tag — no manual `git tag` step is needed. The tag push
then fires `release.yml`; see `kata:agents:rust-lib:*` or
`kata:agents:rust-cli:*` for what release.yml does in each
crate shape.

Cut a release via a small PR — never `git push` the bump
straight to `main`, even though the base block lists version
bumps as an exception to "no direct push". `auto-tag.yml` only
fires on `main`-branch pushes, so the bump must land via a merge
either way; using a PR also gives CI a chance to gate the
release. Enable automerge so CI green = release start:

```sh
git switch -c chore/release-vX.Y.Z
# Edit `package.version` in Cargo.toml, then:
cargo build                     # let Cargo.lock follow
git commit -am "chore: release vX.Y.Z"
git push -u origin chore/release-vX.Y.Z
gh pr create --fill
gh pr merge --auto --squash --delete-branch
```

Once CI is green the PR auto-merges. `auto-tag.yml` then pushes
`vX.Y.Z`, which fires `release.yml`.

**Repo settings to set once:** enable
`delete_branch_on_merge=true` (Settings → General →
"Automatically delete head branches"). The `--delete-branch`
flag on `gh pr merge --auto` is effectively a no-op — gh
returns as soon as automerge is enabled, so the deletion has to
happen server-side, which requires the repo setting.

**Why `KATA_APPLY_TOKEN`:** GitHub refuses to fire downstream
workflows from tags pushed by the default `GITHUB_TOKEN`, so
`auto-tag.yml` pushes with `KATA_APPLY_TOKEN` (the same PAT
`kata-apply.yml` already uses). Each consumer repo needs a
`KATA_APPLY_TOKEN` secret set; if a version-bump merge silently
doesn't fire `release.yml`, the missing PAT is the first thing
to check.
<!-- kata:agents:rust:end -->

## yaiba specifics

Everything above this line is kata-managed. Everything below is not,
and survives `kata apply` — the base and rust blocks are
`how = "merge-section"`, so only the bytes between their markers are
replaced.

### `main` is protected, and two checks are deliberately not required

`main` requires the eleven gating CI contexts: `check`, `test` and
`clippy` across all three OSes, plus `rustfmt` and
`cargo lockfile in sync`. Until this existed, `gh pr merge --auto` had
nothing to wait for and merged immediately — it reads as "merge when
green" and was in fact "merge now".

Two checks are **excluded on purpose**. Adding either deadlocks the
repo's own automation:

- **`review`** (`claude-review.yml`) has a job-level `if:` that skips
  release bumps, `kata-apply/auto`, `apm-bump/auto`, Renovate/Dependabot
  and drafts. A skipped job never reports its context, and a required
  context that never reports blocks the PR *forever* — precisely on the
  PRs the repo relies on auto-merging, including every release.
- **`coverage`** sets `fail_ci_if_error: false` specifically so a flaky
  Codecov upload can't gate merges. Requiring it would take that back.

Other settings and why: `strict` is **off**, so a merge to `main` doesn't
force every other open PR to update first — with stacked branches that is
pure churn. `enforce_admins` is **off**, leaving an escape hatch when CI
itself is broken. No required reviewers: on a solo repo that would block
every merge, since you cannot approve your own PR.

Nothing pushes to `main` directly — `auto-tag.yml` pushes a *tag*, which
branch protection does not cover, and `kata-apply` / `apm-bump` open PRs.
So the protection costs the automation nothing beyond making its
`--auto` merges honest.

### Building the web UI

The UI is compiled into the binary with `rust-embed`, so a stale or
missing `crates/yaiba-server/web/dist/` ships silently rather than
failing.

- **`web/dist/` is gitignored, and `build.rs` creates it.** Without
  that, `rust-embed` fails on a fresh clone before anything has run
  the frontend build. Don't remove it because the directory "should"
  already exist — on CI it doesn't.
- **`release.yml` greps for `[tasks.web-build]` by name.** Rename the
  task and the release still succeeds, having embedded an empty
  bundle. Keep the name.
- **On Windows, `bun run <script>` swallows vite's stdout** — you get
  `$ vite` and then nothing, whether it worked or not. Call the tool
  directly when you need to see output: `node
  node_modules/vite/bin/vite.js build`, `node
  node_modules/typescript/bin/tsc -b`.
- **Anything that produces a shippable binary depends on `web-build`.**
  That is `release-build` and `install`. A bare `cargo install --path .`
  skips it and installs a working binary serving an empty UI — no error,
  because the missing bundle is exactly the silent case above.
- **`.github/workflows/web.yml` is the only thing that type-checks the
  SPA.** `ci.yml` is Rust-only and `cargo make check` is
  fmt-check + clippy + test + lock-check — neither depends on
  `web-build`, so before this workflow existed a TypeScript error
  passed every green check and only surfaced when `release.yml` built
  the bundle on a tag. It is a sibling workflow because `ci.yml` is
  kata-managed and a local edit there does not survive `kata apply`.
  Two properties of it are load-bearing:
  - **It runs on every PR, unfiltered.** A path-filtered check reports
    forever-pending on PRs that don't touch the path, which makes it
    un-requireable, which leaves it advisory — and `gh pr merge --auto`
    merges straight through an advisory red. yukimemi/kanade shipped
    two binary-less releases (v0.44.27, v0.44.28) that way before
    dropping its own path filter.
  - **The job name is the status-check context.** `web build` is in
    `main`'s required checks; renaming the job un-requires it silently,
    because protection keeps waiting on a context nothing reports.

### The binary crate is `yaiba`, not `yaiba-server`

Only the directory carries the suffix, so `-p yaiba-server` fails with
"package ID specification did not match any packages". `cargo make dev`
and `cargo make smoke` both shipped broken for exactly this reason —
neither runs in CI, so nothing caught it.

### The palette is load-bearing

`styles.css` opens with the rule and it is not decorative: cyan is the
blade (cursor, focus, structure), **magenta means critical path and
nothing else**, amber means overdue. A new signal has to earn a colour
or express itself some other way — a hover state that was styled
`--blood` turned out to be invisible on exactly the critical edges it
most needed to mark, and had to become a shape change instead.

Office mode is one variable, not a second stylesheet: `--glow` is `1`
in the dark theme and `0` in the light one, and every shadow is written
`calc(Npx * var(--glow))`. A new glow that hardcodes its blur stays lit
in office mode. Office mode also drops the 刃 from the wordmark and the
tab title — it has to survive a shared screen in a meeting.

### Gantt interaction traps

- **`.gantt__bar` has `overflow: hidden`** to clip the progress fill to
  its rounded corners. An absolutely positioned child that sits outside
  the bar's box is therefore clipped away entirely — invisible *and*
  not hit-testable. This is why the drag grips are siblings of the bar
  inside `.gantt__row`, with `left` set inline from the bar's live
  geometry so they follow a drag preview.
- **`.gantt__links` is `pointer-events: none`** so dependency arrows
  never steal a click meant for a bar. The one clickable path opts back
  in with `pointer-events: stroke` over an 11px transparent stroke; a
  1px line is not something a user can be asked to hit.
- **Drag listeners live on `window`**, installed per-drag in an effect.
  Commit through `commitRef`, never the closed-over props: they are
  memoised on the polled snapshot, so a refresh mid-drag would
  otherwise commit against a stale schedule and file an undo entry
  restoring a value nobody holds.
- **Hit-test a release with `document.elementFromPoint`, not
  `e.target`.** Touch and pen implicitly capture the pointer on
  whatever received `pointerdown`, so `e.target` at release is the drag
  handle. `onMove` uses the same call, so the drop highlight and the
  commit can never disagree.
- **The two panes must be able to scroll equally far.** They stay in
  step by mirroring `scrollTop`, and a pane asked for a position past
  its own end simply stops there — so any difference in scrollable
  height becomes a stretch of scrolling where the list moves and the
  gantt does not, growing until it is capped at the difference. The list
  carried a `40vh` tail below the last row that the gantt did not, so
  the last 40vh of scrolling silently slid every bar out from under its
  title. Both spend `--pane-tail` now, and `syncScroll` clamps to what
  the target can reach for what CSS cannot equalise — the gantt's
  horizontal scrollbar, which eats into its visible height. Anything
  added below either pane's rows has to be added to both.

### The date columns, and the picker over them

- **A cell commits by running the command, not by patching the field.**
  `commitDate` hands `runCommand` the line the keyboard would have
  typed, so `:end` still measures a duration back from the date, an
  actual span is still refused if it runs backwards, and a summary is
  still refused. A second implementation behind the mouse is the one
  that goes stale the next time either changes. It passes
  `selection: [task]` — a click names one row even in visual mode.
- **The keyboard opens the picker in every view.** `cs` / `ce` / `ca` /
  `cA` anchor on whatever is actually mounted: the cell (`data-date-cell`)
  when `:dates` is on, `.row--cursor` when it is not, and the cursor's
  `.gantt__bar` in the gantt-only view, where the list is gone entirely
  — `tab` reaches that view and the key handler has no `view` gate, so
  a chain that stops at the list anchors the panel in the top-left
  corner. Neither a display mode nor a view is a precondition for an
  edit; both are choices about what to *look* at. Reading the box out
  of the DOM is the trade the gantt already makes for hit-testing: the
  geometry is the browser's, and mirroring it into state would only
  give us a second copy to keep in step.
- **A popover opened on `mousedown` must `preventDefault`.** The panel
  focuses itself as it mounts; the browser's own focus move lands
  *after* that and puts it back on the cell, so the calendar opens
  unable to hear a key. The symptom is a panel that renders perfectly
  and ignores every keystroke — `document.activeElement` is what tells
  you, not the screenshot.
- **`picking` must not outlive its row.** The key handler stands down
  while a picker is up, exactly as it does for the project palette, so a
  `picking` left pointing at a deleted or filtered-out task swallows
  every keystroke with nothing on screen to escape from. An effect drops
  it whenever the row leaves `visible`.
- **The picker is keyed on its cell.** Clicking straight from an open
  picker onto another cell never renders a null `picking`: a real mouse
  dispatches `pointerdown` and `mousedown` in one task, so the
  outside-click close and the new open batch into a single render.
  Unkeyed, React reuses the instance and its `cursor` — seeded once at
  mount — keeps showing the month you paged to for the *previous* cell.
- **Style the columns by class, not by sibling.** Painting the actuals
  with `.row__date--opens-actuals ~ .row__date` out-specifies the single
  classes that carry state — empty, locked, picking — so the state
  silently loses on exactly those two columns. Every rule from the base
  down is one class, and later wins.

### A project is a database file

`projects.rs` is an *index*, not a scope. Nothing in `yaiba-core` or
`yaiba-sync` knows what a project is: `entries_since` hands a peer the
whole CRDT log, and `SyncNode::join` overwrites `sync_room_key` for the
replica. Two projects stay apart only by living in different databases —
adding a `project` column would not change that, because the sync
protocol would still ship every row of it.

- **One process holds every project, each with its own `SyncNode`.**
  Identity lives in the database (`sync_secret_key`), so N projects means
  N endpoints — which is exactly what N processes did before, so no
  ticket changed and no migration was needed. The tempting alternative
  (one endpoint per machine, rooms telling projects apart) saves a socket
  and costs every non-default ticket, because the endpoint id is derived
  from the secret being discarded. Don't reach for it without a reason
  worth that.
- **`AppState` serves the active project through `store()`, never a
  field.** The projects vector is fixed at construction so an index into
  it stays valid, and the index is atomic so a switch is visible to every
  cloned `AppState` — axum hands each request its own clone, and a switch
  that only applied to the request that made it would be no switch at all.
  Index 0 is the project that was asked for.
- **Only the active project's failures are fatal.** A background project
  that won't open, or whose endpoint won't bind, is warned about and
  skipped. Otherwise one stale registry entry could lock you out of yaiba
  entirely.
- **The default database is adopted on sight, not on open.** Registration
  used to happen only when the server started, so everyone already using
  yaiba saw `yaiba list` report nothing and `yaiba open` raise an empty
  picker — with their tasks in `yaiba.db` the whole time. `load_registry`
  seeds it on every entry point. `seed_default`'s inner `seed` takes the
  path so tests never touch `YAIBA_DATA_DIR`: `std::env::set_var` is
  `unsafe` in edition 2024, and the environment is shared across parallel
  tests.
- **Register before touching the network.** `main` files the project in
  the registry *before* `SyncNode::start`. The first sync against an
  offline peer blocked past that point and left an unnamed database on
  disk with nothing in `projects.toml` pointing at it.
- **The initial pull is bounded** (`FIRST_SYNC`). `SyncNode::run` retries
  every 30s anyway, so a slow handshake costs a delay; awaiting it
  unbounded cost the UI, because the listener is bound after it.
- **Top-level flags are `global = true`.** Subcommands start the server
  now, so `yaiba open work --port 9000` has to parse. Without `global`
  clap rejects any flag written *after* a subcommand, and every flag
  silently becomes prefix-only.
- **A free name is not a free file.** `joined_db_path` runs the name
  through `slug()`, so `work` and `work!` are one database — and opening
  an existing one as if it were new either fuses two projects or, for
  `join`, overwrites the room key and cuts its peer off. `new` and `join`
  both go through `db_for_new_project`, which checks `find_by_db` and file
  existence, never just `find`. Any future "start a project" path has to
  go through it as well.
- **`same_path` folds `/` to `\` on Windows.** Both separate there, so a
  byte comparison called `C:/x/a.db` and `C:\x\a.db` two databases. That
  is reachable from one `YAIBA_DATA_DIR` typed two ways, and it silently
  defeated the collision check above until a manual run caught it — the
  unit tests all built their paths the same way, so they agreed with each
  other and with the bug.
- **`--join` and `join` are different things** and both are correct.
  The flag merges the current replica into the peer's room (mutual, no
  undo); the subcommand opens theirs as a separate project. `:join` in
  the UI is the flag's behaviour — one server, one database.
- **A `bool` flag's clap `env` is parsed, not sensed.** `#[arg(long,
  env = "…")]` on a `bool` runs the environment value through clap's
  bool parser, so `=1`, `=0` and `=` (empty) all make yaiba *exit* with
  "invalid value" instead of starting — and `1` is what everyone types.
  `Cli::relay_only()` reads a *non-empty* value with `var_os`, the same
  way `updater::disabled_by_env` does for `YAIBA_NO_AUTOUPDATE` — bare
  `.is_some()` would make `YAIBA_RELAY_ONLY=` mean *on*, against both
  that precedent and what clearing a variable means anywhere else. Only
  `YAIBA_UPDATE` can afford clap's `env`: its values are the enum's.

### The firewall prompt on startup is the sync endpoint's

The HTTP listener defaults to loopback, which no desktop firewall asks
about. What raises the Windows dialog on every start — the one wanting
an administrator, which a locked-down machine's user cannot supply, so
it returns forever — is `SyncNode::start`, via iroh.

- **Two separate causes, and stopping one is not enough.** iroh binds
  UDP on `0.0.0.0` *and* `[::]`, and its portmapper probes the gateway
  with SSDP multicast. `Transport::RelayOnly` therefore pairs
  `clear_ip_transports()` with `PortmapperConfig::Disabled`.
- **Verify it by looking at the sockets, not the dialog.** A machine
  that has already been answered once never shows the prompt again, so
  the prompt is not the test — `Get-NetUDPEndpoint -OwningProcess <pid>`
  is. Direct binds two UDP sockets, relay-only binds none, and what is
  left in both is the UI's loopback TCP listener, which is not what the
  firewall was ever asking about.
- **Relay-only still syncs, and the ticket is unchanged.** A peer dials
  a public key; which transport answers is not part of the ticket, so
  relay-only and direct replicas pair up in either direction.

### Whose CA roots iroh trusts, and why not `platform-verifier`

`ca_tls_config` in `yaiba-sync` hands iroh the machine's own CA roots
on top of the embedded Mozilla list, so a TLS-inspecting proxy's
interception CA is trusted for relays, pkarr and DNS-over-HTTPS. Without
it those connections fail `UnknownIssuer` and relay-only sync — what a
locked-down machine is told to use — does not work at all.

- **`CaTlsConfig::system()` is the trap, not the fix.** iroh ships a
  `platform-verifier` feature and it is the obvious answer; on Windows
  it breaks *every* relay. The default relay hostnames are absolute —
  `aps1-1.relay.n0.iroh.link.`, trailing dot — and
  `rustls-platform-verifier` passes that name to CryptoAPI verbatim,
  which compares it against the certificate's dot-less SAN and returns
  `CERT_E_INVALID_NAME`. The symptom is `NotValidForName` on a
  certificate that is perfectly valid; webpki folds the root label away
  and never sees a problem. Roots from the OS, name matching from
  webpki, is the combination that works.
- **The embedded roots stay underneath.** A host with no CA bundle at
  all — a bare container — would otherwise have nothing to verify with,
  and that is `bind()` failing, which for the active project is the
  server refusing to start.
- **`SSL_CERT_FILE` / `SSL_CERT_DIR` now work**, because
  `rustls-native-certs` honours them. `webpki-roots` reads neither,
  which is why no environment variable could rescue a shipped binary
  before this.

### The project palette

- **Switching clears everything derived from the old project.** Cursor,
  visual anchor, `:only` focus, folds and the filter all name things that
  do not exist in the project being switched to — a filter carried across
  would silently hide the new project's tasks and read as the switch
  having lost them.
- **The palette owns the keyboard while it is up.** `onKey` returns early
  on `showProjects`, the same way it does for insert / command / search,
  and the palette's own handler calls `preventDefault` *and*
  `stopPropagation` on every branch it handles. Without that the task
  cursor moves behind the overlay while you are picking.
- **The cursor is clamped against the filtered list, not stored into it.**
  Filtering to fewer rows than the cursor index would otherwise leave
  `<enter>` picking nothing, which reads as the palette ignoring you.
- **A rename is not a switch.** Same database, same tasks, so the view
  keeps its cursor, filter and folds — clearing them for an operation
  that changed nothing but a label is the same surprise from the other
  direction. Create and forget *do* clear, because both land you on a
  different project.
- **Only filtering filters.** Rename and confirm keep the whole list on
  screen so the row being acted on stays visible, which is why `matches`
  short-circuits on `mode.kind`.
- **Confirm shows no input, so something invisible has to hold focus.**
  Without `.palette__offscreen` the panel receives no keys at all and
  `<enter>` does nothing — a state that looks interactive and isn't.
- **Row actions render on the cursor row only.** On every row they are a
  wall of buttons, and `forget` becomes something a mis-click reaches.
- **A bare verb is decided by what exists, not by which verb it is.**
  `:proj new` / `rename` / `forget` with nothing after them switch when a
  project by that name is open — otherwise a project genuinely called
  `new` is unreachable from the command line — and are a usage error when
  none is, which is the likelier reading. `runCommand` takes the open
  names for exactly this. The first version special-cased `rename` into
  an unconditional usage error and left the other two falling through,
  which broke this rule for one of the three; deciding it by existence is
  what let reachability and a good message stop competing.

### Invariants worth knowing before changing the graph

- **Cycles are refused server-side.** `Store::add_dep` calls
  `graph::would_cycle` and returns 409; it catches indirect loops, not
  just the two-node case. Client-side previews are a convenience and
  must agree with it, never replace it — including the expansion below,
  which is the part a preview is most likely to get wrong.
- **A summary is not scheduled, and every edge is expanded to leaves.**
  A task with children takes its span from their union and its progress
  from a duration-weighted roll-up; only leaves are ever scheduled.
  Giving a summary its own dates produces a second answer competing with
  the roll-up, so instead `graph::expand` rewrites each edge to run
  between leaves before either pass sees it: `A -> S` becomes `A -> leaf`
  for every leaf of `S`, `S -> B` becomes `leaf -> B` (the forward pass
  takes the `max`, so `B` waits for the whole bracket), and `S -> T` is
  the cross product. Both passes, the slack that follows and
  `would_cycle` all run on the expanded graph; the roll-up is the only
  thing that does not.
  - **Ask the expanded graph, not the written one,** for anything about
    dates or reachability. Before this existed, an edge touching a
    summary drew, survived the cycle check and moved nothing in either
    direction — `A -> S` named a task the forward pass skips, and
    `S -> B` looked up a finish the roll-up had not computed yet.
  - **Expansion makes some pairings cycles that were not.** An edge
    between a summary and anything inside it becomes "this leaf must
    finish before itself", so it is refused now — correctly, where it
    used to be accepted and then silently ignored.
  - **A leaf stands for itself.** `leaves_beneath` is bounded against a
    parent cycle, and a subtree resolving to no leaves falls back to the
    task itself so its edges stay in the graph rather than vanishing.
- **A malformed graph is a state to survive, not an error to refuse.**
  Two peers can concurrently close a dependency loop or re-parent into
  a cycle, so the renderer degrades rather than throwing.

### Verifying UI changes by hand

`cargo make check` will not catch any of the above — every interaction
bug listed here passed CI.

- **Disable browser extensions that bind keys first.** SurfingKeys
  captures keystrokes on `localhost` and the symptom is
  `defaultPrevented=true` with the app's handler never running, which
  reads like a focus bug and is not one.
- **Automation screenshots are scaled from CSS pixels.** Derive the
  factor from the screenshot width over `innerWidth`, and confirm it
  with a hover probe (`document.querySelectorAll(':hover')`) before
  driving a drag — a few pixels off silently lands on the resize grip
  instead of the bar.
- **Re-measure between gestures.** Committing an edit reflows the
  schedule, so coordinates captured before it point somewhere else
  after.
- **Synthetic events need real gaps.** The drag effect installs its
  listeners after React commits; firing `pointerdown` and `pointerup`
  back to back in one tick misses them. Real input never does this, so
  a failure here is the test's, not the app's.
- **A driven click splits `pointerdown` from `mousedown`; a real one
  does not.** Automation dispatches them as separate tasks, so React
  renders in between and any bug that needs the two batched together
  disappears — a picker that keeps the previous cell's month passed a
  full click-through by hand and only reproduced from
  `el.dispatchEvent(pointerdown); el.dispatchEvent(mousedown)` in one
  statement. "Could not reproduce with the mouse" is not evidence
  against a batching claim; dispatch the pair yourself before deciding.
- **A locked screen looks exactly like an app that ignores you.** With
  the machine locked — or the window minimised, or the tab in the
  background — an injector that goes through the OS has nowhere to
  deliver to. Screenshots keep arriving over CDP and look flawless,
  because that path does not care. So the two readings to tell apart are
  `document.visibilityState === "hidden"` with a keydown listener
  recording nothing, against a real bug in the app.
  `document.hasFocus()` does not separate them — it reported `true`
  throughout. Arm the listener before believing any negative result:

  ```js
  window.__keys = [];
  window.addEventListener("keydown", e => window.__keys.push(e.key), true);
  ```

  **Scope that conclusion to how your keys are delivered.** Empty
  `__keys` means the harness rather than the app *when the injector goes
  through the OS*, which is what a screenshot-and-click driver does. A
  CDP or Playwright dispatch aimed at a page reaches it whether or not it
  is visible, so there an empty `__keys` really is worth investigating —
  check the injector, and that you targeted the frame you think you did,
  before blaming either side. Dispatching a synthetic `KeyboardEvent` at
  `window` from inside the page bypasses the question entirely and is the
  cheapest way to exercise the key handler when the screen is not
  available.

  A page that was hidden *before it ever rendered* has a second tell:
  `#root` is still empty, because the first render was skipped along with
  everything else. Useful when you see it, but not part of the signature
  — a page that rendered and was then hidden keeps its DOM, so a
  populated `#root` rules nothing out.

  This is the trap that produced a wrong bug report on #75: a keystroke
  that was never delivered got read as the app losing a visual selection,
  and the note that went in here first claimed bursts of keys outrun
  React. They do not — `App.tsx` mirrors the mode, cursor and anchor into
  refs that every handler reads and writes synchronously, so a burst
  cannot see a stale render. What actually collapsed the selection was
  the `:` command path reading the *memoised* selection instead, which is
  the bug fixed in #75.

### Traps in the worktree loop itself

**`renri remove` can half-succeed.** A `cargo run` launched from a
worktree leaves `target/debug/yaiba.exe` running after the parent is
stopped — process-tree kills do not always reach it — and Windows then
refuses to delete the directory. `renri remove` forgets the workspace in
jj and *then* fails with `os error 5`, so the worktree is gone from
`jj workspace list` while its files are still on disk, and `renri prune`
reports nothing to prune. Kill the server first:

```powershell
Get-Process | Where-Object { $_.Path -like "*wt*<name>*" } | Stop-Process -Force
```

Drop the `| Stop-Process -Force` to see what it would kill first — the
pattern matches on the executable's path, so a second worktree with a
similar name is worth a look before the pipe.

**`jj commit -m` overwrites a description you already wrote.**
`jj describe -m "…"` sets the description of the working-copy commit;
`jj commit -m "…"` sets it **again** and then starts a new commit. Doing
the second after the first means the message you wrote is gone and the
changes you meant to separate are one commit — silently, since both
commands succeed. It happened on #75: a carefully written feature commit
came out labelled as the small fix that followed it, and was only caught
by reading `jj log` after the push.

Use `jj describe` then `jj new` (two steps, and `jj log` in between shows
what you are about to get), or `jj commit` alone with no prior
`describe`. Related: `jj git push` does **not** advance a bookmark onto a
new commit — `jj bookmark set <name> -r <rev>` first, or the push reports
"Nothing changed" while your work sits unpushed.

Everything in this subsection is general jj / renri behaviour rather than
anything about yaiba, so its durable home is the `pj-base` template that
owns the worktree section above; it is written here because that is where
it was learned, and should move upstream when those templates are next
touched. The browser-input note under *Verifying UI changes by hand*
stays put — it is about this app's own harness and keybindings.
