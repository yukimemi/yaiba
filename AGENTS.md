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

**In a workspace, the version is in more than one place.** A member
that is published and depended on by another member is declared
with both a `path` and a `version` — crates.io needs a
requirement it can resolve for somebody who is not building from
the checkout, so a bare `path` will not do:

```toml
my-core = { path = "crates/my-core", version = "0.4.2" }
```

That literal does not follow `[workspace.package] version`.
Nothing in Cargo makes it, and the release above will not either.

**It fails late and quietly.** `version = "0.4.2"` means `^0.4.2`,
so a stale pin keeps resolving through every *patch* release and
stops only at the first bump that crosses the minor — where
`cargo build` refuses with `candidate versions found which didn't
match`, in the middle of cutting the release. Two repos on these
templates hit exactly this, one of them three releases after its
pins were last correct, and the other had already written the
hazard down in prose and drifted anyway.

So bump the pins in the same commit, keep them in
`[workspace.dependencies]` rather than in each member, and assert
it rather than remembering it. A test is the cheapest place —
`cargo test` already runs in CI, and it needs no toolchain a Rust
workspace does not have. [pj-rust-workspace's
README](https://github.com/yukimemi/pj-rust-workspace#the-internal-version-pin-and-the-check-for-it)
carries one to copy into any member's
`tests/check_versions.rs`: `internal_pins_match_the_workspace_version`
fails when a pin and the workspace version disagree, and
`members_inherit_the_workspace_version` fails when a member writes
its own version or reaches for a sibling by path.

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

### A release bumps one line, and a test makes sure that is true

The kata-managed release section above says to edit
`[workspace.package] version` and let `cargo build` follow. That is now
the whole edit, but it was not always: until v0.17.0 the three crates
depended on each other through longhand `path` dependencies that each
carried their own `version` literal, and a release had to bump four
files. They now live in `[workspace.dependencies]` — where the block's
own comment already said version bumps should happen — and the members
say `yaiba-core.workspace = true`.

**The literal cannot go away entirely.** All three crates are published,
and crates.io needs a requirement it can resolve for somebody who is not
building from this checkout, so a `path` alone will not do. What it can
be is *one* place, next to the version it has to agree with.

**The failure mode is silence, not breakage.** `version = "0.16.0"` is
`^0.16.0`, so a stale pin keeps resolving through every patch release and
only stops the first release that moves the minor — v0.17.0 was that
release here, three bumps after the pins were last right, and it failed
with `candidate versions found which didn't match`. So
`crates/yaiba-core/tests/check_versions.rs` asserts the pins equal the
workspace version, and it is a test rather than a script because
`cargo test` already runs in `cargo make check` and in CI. Confirmed both
ways: a patch drift builds clean and fails the test; a minor drift never
reaches the test because cargo refuses to resolve first.

It also refuses a member that writes its own `version` or reaches for a
sibling by `path = "../"`, since both are how the four-file version of
this came about.

**`kanade` has the same shape and is mid-drift** — workspace at 0.45.4,
`kanade-shared` pinned at 0.45.0 — and is green only because it has not
bumped a minor since. Worth porting this test there rather than waiting
for the release that trips over it.

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

Alpha is the other theme trap. A signal fill written for `--void:
#05070d` at 0.12–0.14 washes out to nothing over white (0.14 amber is
`#fef6e0` — the page background to the eye). When a fill *is* the
signal, as the overdue bar's is, office mode needs it re-stated
stronger; the overdue rules at the end of the gantt block are the
pattern to copy.

### The MCP server is a client, not a second writer

`yaiba mcp` (`mcp.rs`) serves the plan to an agent over stdio. It reaches
yaiba through the **HTTP API**, never the database — opening `yaiba.db`
here would make it a second writer, against the one-process rule in the
projects section above, and would mean re-implementing every refusal the
server already makes. As a client it gets them for free: a cycle is a 409
carrying the server's own message, a summary's dates are still refused,
and an agent cannot reach a state a person could not type. The cost is
that yaiba has to be running, which `serve` checks up front rather than
letting the first tool call be the thing that fails.

Four things that were wrong first and are worth keeping right:

- **stdout is the protocol.** `main` initialises tracing on stdout for
  every other subcommand; the `Mcp` branch sends it to stderr instead.
  Without that the first log line is a parse error at the client, and the
  symptom — a server that connects and then dies on its first message —
  points nowhere near the logging call that caused it.
- **`Implementation::from_build_env()` reads the SDK's own
  `CARGO_PKG_*`.** It is the documented way to fill in the server
  identity, and on its own it made the client show the user
  "rmcp 3.1.0". Name and version are overwritten with `env!`, which
  expands in *this* crate. `Implementation` is `#[non_exhaustive]`, so
  that has to be a mutation rather than `..` update syntax.
- **A write reports the state it lands in, not a delta.** "The finish
  moved a week earlier" is the better sentence and was the first version,
  which read the state either side of the write. Three separate requests
  means anything editing in between is attributed to this edit — driving
  four writes at once, all four claimed the same change. A number that is
  only true when nothing else is happening is worse than no number.
- **The short id is the *last* UUID segment.** Ids are UUIDv7 and lead
  with a timestamp, so three rows created in one loop all rendered as the
  same eight characters — not a name. `resolve` matches the trailing
  segment as well as a leading prefix.

`#[tool_handler(router = self.tool_router)]` rather than a bare
`#[tool_handler]`: the bare form works, but the field then reads as dead
code and `clippy -D warnings` fails the build.

### Where the blade is drawn, and how it is put away

Completion was the only effect for a long time: `x` swept a stroke across
the row and left the line-through behind. There are five now, and they
are one object seen at different moments rather than five decorations —
`flash.ts` holds the kinds and the timings, `check-flash.ts` holds the
stylesheet to them.

- **Three of them are a task's life**: `born` on create (the draw, left
  to right), `cut` on complete (the signature, unchanged), `slain` on
  delete (the cut with the magenta taken out, and the row falls away from
  it). The other two are `sever` on an edge and `wipe` across the shell.
- **An undo draws the stroke its ops describe, not one of its own.**
  `u` was the last gesture that changed the plan and left no mark on it.
  `runStep` reads the ops it is about to run — `restore` is a task born
  again, `delete` is one cut down, `patch` is a row redrawn — so a `u`
  over a forty-row paste draws forty, and the label is never consulted.
  `reorder` and the dep ops stay silent on purpose: flashing a reorder
  means flashing every row, which says nothing about which one moved,
  and an edge has a `sever` for being cut and nothing for coming back.
  The removals go first and wait `SLAIN_MS`, the same bargain
  `deleteSelection` makes — a row already gone has nothing to draw on.
- **Only `cut` spends magenta.** It predates the rule in the palette
  section above and is the one exception to it; the strokes added beside
  it are cyan, and a sixth should be too. A stroke is a moment, not a
  status, so it has no claim on a colour that means something.
- **A destructive stroke runs *before* the write, not after it.** An
  element that unmounts on the click has nothing left to animate, which
  is exactly why cutting a dependency — the gesture the app already
  *called* cutting — had no blade in it. So `deleteSelection` and
  `onUnlinkDep` both file their ops on a timer, and those two delays
  (`SLAIN_MS`, `SEVER_MS`) are the only place in the app where an effect
  costs a write any latency at all. Keep them short and keep them the
  shortest of the strokes. Everything else about the gesture still
  happens immediately — the cursor moves, visual stands down, the
  register fills — so a second `dd` inside the window names the row below
  exactly as it would have. What the window does leave open is a `u`
  typed inside it taking back the step *before* the delete, since the
  delete is not filed yet.
- **Both panes draw, because either can be the only one on screen.** In
  the gantt-only view the list is unmounted entirely, so a completion
  drawn on a row alone was a completion nothing drew. `flashes` goes to
  `TaskList` and `Gantt` both, and the bar clips its overflow so the
  sweep runs inside the task's own width.
- **A severed edge stops being clickable while it plays.** `Gantt` drops
  the `.gantt__link-hit` path, which is both true — there is nothing left
  to cut — and necessary: the hover rule it drives is written
  `.gantt__link-hit:hover ~ .gantt__link`, three classes' worth of
  specificity, and it would otherwise paint its grey dashes straight over
  the stroke with the pointer sitting right on it.
- **The wipe is an element, not `.app::before`.** That one is the boot
  and has already run; an animation only replays from a fresh node, which
  is what the `key={wipe}` counter is for. It is keyed on the *previous*
  view rather than a "have I mounted" flag so StrictMode's second pass
  cannot spend the flag and play a wipe over the boot sweep.
- **Every stroke has to be turned off twice, and `check-flash.ts` fails
  the build if one is not.** Office mode has to survive a shared screen
  and `prefers-reduced-motion` is not a preference to honour when it is
  convenient. Neither is visible to `tsc`, and the class names are built
  from the kind (`row--${kind}`), so a kind added with no CSS behind it
  compiles perfectly and draws nothing. Note the one asymmetry the check
  encodes: under reduced motion `row--slain` keeps its `opacity`, because
  blanking the row and *then* deleting it 200ms later is two disappearing
  acts for one delete.

### Super mode is a third theme, not a second switch

`data-theme` holds `dark`, `light` or `super`, and the loud mode is a
*value* of it. The alternative — a `data-super` toggle beside the theme —
is the one to argue back at, because it looks tidier and is worse: it
admits a fourth combination, office mode with the effects lit, which has
no meaning and nothing sensible to draw, and it makes every rule in the
section carry two attributes to say so. One attribute means the
combination cannot be expressed.

- **`gt` leaves super, and that is the rule rather than an accident.**
  It was `prev === "dark" ? "light" : "dark"` and had to become
  `prev === "light" ? "dark" : "light"`: the old spelling read super as
  "not dark" and sent `gt` further *into* the neon end, from the loudest
  screen in the app, at the moment somebody was reaching for the
  quietest. `gs` / `:super` is the other switch and lands on plain neon,
  deliberately not on "whatever you were in before" — a key that
  remembered would mean two things.
- **Every ambient effect rests at `opacity: 0` and draws itself out of
  its keyframes.** `prefers-reduced-motion` turns the whole section off
  with a single blanket `animation: none !important` rather than a list
  of selectors — a list is the second list to keep in step, which is the
  drift `check-flash.ts` exists to catch — and a blanket can only work
  when stopping the clock leaves nothing behind. `check-flash.ts` asserts
  both halves: the blanket is there, and every super rule that conjures
  an element with `content: ""` also states `opacity: 0`.
- **The palette rule survives being turned up.** Magenta is still the
  critical path and nothing else: the completion stroke keeps its old
  exception, the critical bars are what march and pulse in it, and
  everything invented for this mode — aurora, sheens, roll, bursts — is
  cyan and white. A decorative magenta would cost the most exactly here,
  where there is the most light to compete with.
- **The two screen-level effects are the one place the mode reaches the
  render tree.** The burst is not left to the stylesheet the way `--glow`
  is, because `.app` is a grid and an unstyled fourth child would take a
  row of it. The shake is spelled twice — `QUAKE_CLASSES` — because an
  animation replays from a fresh node or a different `animation-name`,
  and remounting `.app` would take the focus, the scroll positions and
  any open editor with it. Consecutive deletes alternate the two names;
  `check-flash.ts` asserts they name different keyframes *and* that the
  two keyframes are identical.
- **The caret's strikes are imperative, and that is the point.**
  `Strikes.tsx` makes its own nodes and takes them out on
  `animationend`. Routing them through state would put an `App` render —
  the component holding the task list, the schedule and the gantt —
  behind every keystroke, to add three elements that describe nothing
  and are gone in 400ms. Nothing there is state. For the same reason it
  hangs off one `window` listener rather than the inputs' own handlers:
  typing happens in a row title, the `:` line, search, the project
  palette and the owner panel, and a decoration is not a reason for five
  components to learn about each other.
- **The caret is measured, not counted.** `column × character width`
  looks right in a monospace app and is wrong the moment a title is in
  Japanese — those glyphs are full-width in every font `--mono` names.
  `measureText` on the actual prefix costs one call and is right in both
  scripts.
- **An IME sends `key: "Process"`, so the key path never sees Japanese
  at all.** Not just the keydowns flagged `isComposing` — every one of
  them, from the first, because with the IME on the keystroke goes to
  the IME rather than to the field. A printable-character test drops the
  lot. This shipped for review listening only for `compositionend`, and
  the effect it produced was a whole word typed in silence and one puff
  at 変換 — read from the outside as "Japanese isn't supported", which
  is how it came back. `compositionupdate` is the keystroke and is what
  had to be listened for; `compositionend` stays as the heavier commit.
  Confirmed rather than assumed: a `key: "Process"` keydown dispatched
  at the field draws nothing, before and after.
- **`animationend` is the only thing that removes a strike, and a hidden
  tab never sends one.** The document timeline stops advancing entirely
  when the tab is not visible — `document.timeline.currentTime` sits at
  0 — so nothing ends and nothing is removed. A person cannot type into
  a tab they cannot see, so the case that matters is the harness's:
  driving the app over CDP piles nodes up until `STRIKE_LIMIT` stops
  them, and the same freeze makes any check that waits for an effect to
  finish read as a broken effect. Confirm `document.visibilityState`
  before believing one. The cap is what keeps that bounded, and is worth
  keeping for that reason alone.
- **A stripe that marches is drawn straight, not diagonally.** The
  animation shifts `background-position-x`, and on a diagonal the loop is
  seamless only when the offset equals the stripe period over the cosine
  of its angle — an irrational number that will not survive anybody
  editing the stripes. Straight stripes make the offset the period.

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
- **`scrollIntoView` cannot see the sticky head, so the panes have to
  tell it.** `TaskList` keeps the cursor on screen with
  `scrollIntoView({ block: "nearest" })`, which measures against the
  scrollport and knows nothing about an element pinned inside it — so a
  jump *upwards* to a row above the viewport parked it flush against the
  top edge, with the two rows the header covers left invisible. `G` then
  `gg` on a long list was the way to see it: `scrollTop` landed on the
  head's own height rather than 0, and tasks 1 and 2 were simply gone.
  `.pane` spends `scroll-padding-top: var(--pane-head)` for it, and the
  head heights are that same variable so the two cannot drift apart. It
  is on `.pane` rather than `.pane--list` because the gantt mirrors the
  list's `scrollTop`: a row parked under one head is parked under the
  other. Same rule as the tail above — anything that pins itself over
  either pane's rows has to be paid for in the scroll padding, or
  `scrollIntoView` will hide rows behind it.
- **Following the cursor is two axes, and the panes own one each.**
  `Gantt` has always chased it horizontally — a bar scheduled months out
  is otherwise something to go hunting for — and left the vertical to
  `TaskList`, which is right while the list is mounted, because the two
  panes mirror `scrollTop` and a second pane scrolling itself would be
  two answers to one question. In the gantt-only view there is no list
  to ask, so there was nobody: `G` moved the cursor to the last task and
  the pane stayed at the top, with the cursor rows below the fold. The
  vertical follow lives in `Gantt` now behind `if (!onlyPane) return`,
  which is the same shape as the flashes drawing in both panes — either
  pane can be the only one on screen, so whatever a row needs has to be
  reachable from both. It is a `scrollIntoView` rather than arithmetic
  on `ROW_H` so the head's height stays the stylesheet's to know, and it
  cannot disturb the horizontal axis: `.gantt__row` is `left: 0;
  right: 0` over the whole timeline, so it always overlaps the
  scrollport and `inline: "nearest"` has nothing left to do.

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
- **`h` / `l` are one motion, resolved at two scales.** They fold (#82)
  *and* walk the cells (#87), and the two are not a conditional on the
  display mode — which would be the "a display mode is a precondition
  for an edit" this file refuses six bullets up. They mean one step out
  and one step in; a cell is a smaller step than a subtree, so the cells
  answer first and the fold answers at the leftmost one, where there is
  no cell further out. `compact` has a single column, so every `h` / `l`
  there reaches `foldStep` with nothing in front of it — identical to
  what #82 shipped, and asserted as such in `check-cells.ts` rather than
  promised in a comment.
- **Neither half of that decision lives in the key handler.**
  `cellStep` says which of the two owns the key, `foldStep` says what
  the fold does; both are pure and both are run by `web-build`. A rule
  only a real keyboard can check is how #80 shipped.
- **An edit key edits the cell under the cursor — every edit key, not
  just `⏎`.** `i` / `I` / `a` / `A` / `cc` shipped reading the row and
  `⏎` reading the cell, so walking to `end` and pressing `a` opened the
  *title*: the walk was somewhere to look rather than somewhere to
  work, which is the display-mode-as-precondition trap from the other
  side. `cellEdit` is the one rule now, and `⏎` runs it too. On the
  title they still differ by caret and by whether the old text is kept,
  which is the only question a panel has no answer to. **`cc` is the
  exception that isn't:** it is *spelled* after the `c` family, where
  `cs` / `ce` / `co` each name a field and reach it from anywhere, but
  the spelling is not the rule it lives under — what the fingers mean
  by `cc` on a cell is that cell, and jumping back to column one from a
  date you had walked to is the same surprise the insert keys were
  fixed for. Nothing is lost: both panels carry a `clear`, and the
  title is one `h` back, or `:title`.
- **A put runs the command line, a yank reads the field.** `cellWriteLine`
  returns the line the keyboard would have typed and `pasteCells` runs
  it, so `:end` still measures a duration, an actual span that runs
  backwards is still refused and a summary's plan is still refused —
  none of it restated at the paste. `:title` exists for exactly this
  reason: the title was the one field with no command behind it, and a
  block carrying a title column had no line to run.
- **`end` is written in a second pass.** It measures back from the row's
  start, so a block carrying both would compute the span against the
  start it is in the middle of replacing. Two awaited passes, then the
  filed undo steps are merged — one gesture is one `u`, the same shape
  `paste` uses for rows.
- **Two registers, and `p` puts the last one filled.** Rows create
  tasks, cells overwrite fields on tasks that exist; a `p` that guessed
  from the cursor would guess wrong on the row you were about to
  duplicate. `lastYank` is the whole rule. `P` stays row-only — a cell
  block overwrites where you point it, so it has no side to land on.
- **Nothing is dropped silently.** A block that half landed looks
  exactly like one that landed, and the columns it missed are the ones
  nobody thinks to check, so `pasteCells` names every reason it skipped
  something and downgrades the message from `ok` to `info`.
- **The cell cursor is derived, not reset.** `cellRaw` holds where you
  walked to and is clamped through `cellColumns(columns)` on every
  render, so turning `gd` off cannot leave the handler holding a column
  nothing is rendering — the same hazard as `picking` outliving its row,
  without needing an effect to catch it. It is deliberately *not*
  cleared when the cursor row changes: keeping the column while `j`
  moves is what makes a column fillable straight down the page, which is
  the whole point of #87.
- **`V` is linewise, and that is what decides the verb — not the verb.**
  It shipped as "the same rectangle, pinned to the full width", so
  `V j j y` took six cells where `V j j Y` took two rows, and the two
  readings would have split again the moment `d` arrived. `V` selects
  *rows* now: `y` fills the row register there and `d` deletes the tasks,
  exactly as `Y` and `dd` do. `v` is the only cellwise one. A key that
  asks "which am I?" reads `visualLineRef`, and nothing branches on which
  letter was pressed.
- **Being a prefix is a property of the mode.** `y` and `d` wait for a
  second key in normal, where `yy` / `dd` mean the row, and fire on their
  own in visual, where you have already said what you are acting on.
  Nothing is lost to a doubled habit: the first key leaves visual, so the
  second lands in normal and simply waits there.
- **`x` is the picker's own key, lifted onto the grid.** `DatePicker`
  has always read `x` as clear, so `x` on a cell is that same reading one
  level out — `cellClear` is the whole rule, `dl` is vim's spelling of it,
  and `dh` deliberately does not exist because it would edit the cell
  *beside* the cursor. Two cells answer differently and both are asserted
  in `check-cells.ts` rather than promised here: `end` is refused through
  the same `clearable` flag that hides the picker's clear button, and the
  title is `cc`, because `finishEdit` refuses a blank title so "clear the
  title" has no committed state to land in. Done moved to `<space>`,
  which was already an undocumented alias for `x`.
- **Standing visual down means all four pieces.** `deleteSelection`
  cleared the mode and the row anchor but left `anchorCell` and
  `visualLine` set. That was inert while only `dd` reached it — nothing
  outside visual reads either — and became a linewise flag surviving into
  the next selection the moment `V` + `d` arrived. `leaveVisual` is the
  shape to copy, and note it stands *down* rather than standing by: it
  returns early unless the mode is still `visual`, so a path that opens an
  insert first (`x` on a title) has to call it *before* the edit or it
  does nothing at all.

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
- **`join` and `merge` are opposites, and one word used to mean both.**
  `join` opens the peer's tasks as a project of their own; `merge` puts
  both task sets in both replicas and leaves this one's sync room, which
  has no undo. Until v0.21 the second of those was spelled `--join` — a
  flag, beside a `join` subcommand doing the opposite, plus a `:join` in
  the UI that was the *flag's* reading. That cost a real separation, and
  the person it cost had read the docs. The lesson to keep: a
  destructive operation must not share a name with its safe counterpart,
  and if it must differ, it should be the destructive one that is longer
  to type. Every path in and out of `join`/`merge` is now one word for
  one meaning, and `--join` refuses with both replacements named — never
  mapped onto either, because it *did* the merge (so routing it to
  `merge` preserves the accident) and people reached for it wanting
  `join` (so routing it there changes what a working command does).
- **`leave` is the way back out, and it has to be both halves.**
  `SyncNode::leave` forgets the peers *and* mints a room. Dropping the
  peers alone stops this replica dialling out and nothing else — the
  others still hold this endpoint's id and the room, and `serve` files a
  peer that presents the room the moment it arrives, so the next inbound
  sync would put the whole group back. The test does not check that we
  stopped dialling; it makes the peer dial *us*, which is the direction a
  half-done leave quietly restores.
- **Giving up the room and admitting a peer are one critical section.**
  `serve` runs on its own spawned task, so a `leave` that swapped the
  in-memory room *after* its store write left a window where an inbound
  peer passed `room_matches` against the old room and filed itself after
  the clear — on disk as well as in memory, so a restart loaded it back.
  Both take the store lock around the whole decision now. That fixes the
  ordering to store → room/peers everywhere, which is why `sync_with`
  binds the room to its own `let` before building `Hello`: inline in the
  struct, the temporary guard lived to the end of the statement and held
  room across `with_store`, the one inversion that could deadlock.
  The two disk writes are one transaction for the same reason a grain
  coarser — a crash between them is the half-done leave on disk.
- **Leaving moves the ticket, and that is the surprise worth saying out
  loud.** A ticket is the endpoint and the room together, so a new room
  cuts off every replica holding the old one — the user's own second
  laptop included. The secret key is deliberately kept, so the replica
  stays itself and its history is untouched. What no version of this can
  do is take anything back: whatever synced is on their disk for good,
  and a message implying otherwise would be a lie about a CRDT.
- **It runs through the server rather than as a side-door write.**
  Clearing the peers and minting a room needs no endpoint at all, so a
  standalone `yaiba leave` writing straight to the database is the
  tempting shape — and it is a second writer against a running yaiba,
  which holds the room and the peer set in memory as well as on disk, so
  the next thing to touch either would undo it. Same one-writer rule
  `mcp` follows, for the same reason; `Target::leave` carries it through
  startup.
- **`:join` in the UI is the safe one now, and that became possible
  rather than being an oversight.** It was the flag's behaviour because
  one server held one database. `AppState` holds every project with its
  own `SyncNode`, so `POST /api/projects/join` can create a database,
  register it, bind an endpoint and adopt the ticket without a restart —
  it is `create_project` plus a ticket, which is why both routes go
  through one `open_new_project`. When a doc comment explains a UI
  limitation by a constraint, check the constraint still holds.
- **A `bool` flag's clap `env` is parsed, not sensed.** `#[arg(long,
  env = "…")]` on a `bool` runs the environment value through clap's
  bool parser, so `=1`, `=0` and `=` (empty) all make yaiba *exit* with
  "invalid value" instead of starting — and `1` is what everyone types.
  `Cli::relay_only()` reads a *non-empty* value with `var_os`, the same
  way `updater::disabled_by_env` does for `YAIBA_NO_AUTOUPDATE` — bare
  `.is_some()` would make `YAIBA_RELAY_ONLY=` mean *on*, against both
  that precedent and what clearing a variable means anywhere else. Only
  `YAIBA_UPDATE` can afford clap's `env`: its values are the enum's.

### Neither side of the exchange may slam the door

`sync_with` and `serve` are one round trip — hello, offer, push — and
both sides used to hang up the moment they had written their last frame.
That cost the push, every time, in the direction nobody watches.

- **`finish()` is not "sent", and closing is not free.** `finish()` says
  only that this side will write no more. `conn.close()` puts a
  CONNECTION_CLOSE on the wire immediately, and a peer still reassembling
  a stream is entitled to drop it when that frame lands — so the frame
  written one line earlier never arrives. **Dropping a `Connection` does
  the same thing**: it closes with code 0, which is how `serve` was doing
  it without a `close()` call anywhere in it. Both ends had this and each
  hid the other while the tests were single-sided.
- **What it looked like from the outside** is the reason it survived a
  release: the dialler received the offer, so the other replica's edits
  kept turning up within the 30s tick and sync read as working. Only the
  push was lost, so the dialler's *own* edits went nowhere — and the 30s
  retry re-ran the identical exchange rather than repairing anything. The
  HUD agreed with the wrong side, because `peer_ids()` on a joiner is
  filled by `join()` from the ticket alone, with no contact of any kind.
  "1 peer" there means "I wrote their id down".
- **The waits are deliberately different.** The dialler reads its peer's
  stream to EOF, because `serve` finishes only after merging the push:
  the EOF is proof the push was *acted on*, which `stopped()` would not
  give — it says bytes were acknowledged. The listener uses `stopped()`,
  because all it needs is its own FIN out of the door. Neither is a wire
  change, so replicas either side of the upgrade still pair up.
- **A peer is filed before a single entry is handed over**, right after
  the room check, not at the end of the exchange. The room key is the
  whole authorisation and they have just presented it. Filing at the end
  meant any failure in the tail left this replica having given away its
  entire dataset to a peer it kept no record of — and with no record it
  never dials back, so one dropped frame became a permanently one-way
  pairing instead of something the next tick fixed. `serve` must never
  register *before* `room_matches`, which is what
  `a_stranger_is_refused_and_filed_nowhere` is there to hold.
- **The tests bind loopback only** — `presets::Minimal`,
  `clear_ip_transports()`, then an explicit `127.0.0.1:0`, with a shared
  `MemoryLookup` standing in for discovery. That keeps them off CI's
  network and away from the firewall prompt in the section below, which
  on the machine this bug was found on cannot be answered at all.
  `SyncNode::serve_on` exists for that and for nothing else.
- **Assert both directions from one exchange.** One direction working is
  exactly what this bug looked like. The tests need no sleep: after the
  fix, `sync_with` returning *is* the proof the far side merged.
- **Every wait on a peer needs a ceiling, and the QUIC idle timeout is
  not one.** A peer whose endpoint driver still answers while its
  application is wedged — blocked on a slow store write inside `merge` —
  keeps the connection healthy while never writing the frame this side
  waits for, so the transport sees nothing wrong. `sync_all` walks its
  peers *in sequence* and `POST /api/peers` awaits it directly, which
  makes one unbounded wait the whole replica's problem plus an HTTP
  request that never answers. `EXCHANGE` bounds one exchange; only the
  startup pull was bounded before, by `FIRST_SYNC` in the binary. Cheap
  to abandon: the driver retries every `IDLE_SYNC` and a CRDT exchange
  is idempotent, so a ceiling costs a delay and never data.

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

### Where UI state is remembered

Two scopes, matching what the project switch already treats as portable.
Settings that name no task — **view, zoom, columns, sort** — are global,
in localStorage under `yaiba:view` (`uiState.ts`), the same pattern as
`yaiba:theme` / `yaiba:lang`. State that names task ids — **folds, focus,
filter, fold level** — is per-project, in the project database's `meta`
table behind `GET`/`PUT /api/ui`, so a rename keeps it (same database) and
it never syncs to a peer (`meta` is not part of the CRDT log; `put_ui`
deliberately does not bump `notify`).

- **Saves are gated on `uiLoadedRef`, checked twice.** Writing the
  mount-time defaults before `GET /api/ui` answered would turn every
  reload into the reset this exists to fix, and a debounced write armed
  just before a switch would land the outgoing project's state in the
  incoming one's database — so the gate is closed *before* the server
  moves, and re-checked inside the timer callback too.
- **Every path that changes which database is served closes it, not just
  `switchTo`.** Create, forget and join all land you on a different
  project, and all three closed it on the way *back*, inside
  `adoptProjects` — by which time the server had already moved and a
  debounce firing mid-request had already written the outgoing project's
  folds into the incoming one. `landOnProject` is the one place that
  closes it now, and it exists because the rule was written down for
  `switchTo` specifically and the three siblings were read as exempt.
  Note the window is not a formality: `joinProject` pulls from the peer
  before it answers, so it can be seconds wide. On failure nothing moved,
  so the gate reopens — after `failProject`, not before it.
- **A restored focus is validated against the task list.** A peer may
  have deleted its root since the state was saved; showing the subtree of
  a task that no longer exists renders an empty list, which reads as the
  app having lost the plan. Folds need no such check — an id in
  `collapsed` that is gone is simply never matched.

### Invariants worth knowing before changing the graph

- **The reference date moves the line, not the plan.** `today` reaches
  exactly one thing inside `schedule()`: the drawn window's left edge.
  No task's dates depend on it, and that is what makes `:asof` a report
  rather than a re-plan — scrub to Friday and the bars stay where they
  are, so the ones the line has passed are visibly late. Anything new
  that wants to read `today` in the scheduler is almost certainly the
  bug this rule exists to prevent; ask whether it belongs in the *view*
  instead.
- **An unpinned task starts on the day it was typed** (`created_day()`,
  local — `created_at` is UTC and the trap is documented on both it and
  `Store::snapshot_at`). This anchor has now been wrong twice, and both
  wrong answers moved on their own: `project_start` (#85) sank every new
  task to the oldest pin in the plan, and `today` (#88) slid unstarted
  work forward a day every day, so an untouched plan finished later each
  morning and `:asof` silently re-planned. `created_at` is the only date
  a task carries that cannot move by itself. The cost is deliberate: an
  old unpinned task sits in the past rather than at today's edge, which
  is what being late looks like. #88's argument — "a plan for work that
  has not happened cannot honestly begin before today" — is the reading
  that hid the drift, and is not the one to restore.
- **The drawn window is asked of the schedule, not of the pins.**
  `project_start` is the minimum of the *computed* starts, capped at the
  reference date so the line stays in frame. It read the pins while an
  unpinned task could never start before `today`; anchored on the
  creation day one routinely does, and a bar left of the window is drawn
  at a negative offset inside a pane whose `scrollLeft` stops at 0 —
  stored, and on screen for nobody. `App.tsx` widens the same window for
  the actual rails, which have always been able to predate the plan.
- **Cycles are refused server-side.** `Store::add_dep` calls
  `graph::would_cycle` and returns 409; it catches indirect loops, not
  just the two-node case. Client-side previews are a convenience and
  must agree with it, never replace it — including the expansion below,
  which is the part a preview is most likely to get wrong.
- **A pinned start is a floor, and a pin adjusts the lag it crosses.**
  The forward pass takes `max(pin, pred_end + lag)`, so a pin dropped
  inside an edge's lag used to slide to the day the edge asked for —
  the date visibly ignored. `pinStartOps` (web `commands.ts`) is the
  one place that rule lives now: the pin adjusts every crossed edge's
  lag to the spacing the date implies, and a pin before a predecessor's
  finish — which would invert the edge — is refused. `:start` runs it,
  and the calendar picker, a cell paste, the bar drag and `.` / `,` all
  commit through those; the gantt's move preview clamps at the same
  floor (`earliestStart`) so what you see is what the release commits.
  A fifth path that patches `start` directly is the one that goes
  stale.
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

### `runKey` is the command layer, `onKey` is the event

`App.tsx` splits the keyboard in two. `onKey` is about the *press* —
which overlay owns the keyboard, the modifiers, `NORMALIZE`, the
pending-key buffer that makes `dd` and `gp` two presses of one command,
and the count. `runKey(cmd, count, counted)` is about the *command*, and
is the whole 470-line switch.

The split exists so something other than a keyboard can ask for a
command, and the row menu is that something. Consequences worth knowing:

- **A menu item is the key it advertises, not a copy of it.** Items carry
  a `runKey` string and nothing else, so a refusal — a locked cell under
  `:asof`, a summary's plan, a blocked move — happens once, in the place
  it always did. This is the bargain `commitOwner` and `commitDate`
  already make with the `:` line, one level down.
- **`counted` is not `count > 1`.** `1gg` and a bare `gg` both mean row
  one; `1G` means row one where `G` means the last. Only the *presence*
  of a typed count separates them, which is why it is a third argument
  rather than something inferred. It was `match?.[1]` before the split,
  reading the regex from inside the switch.
- **`liveCursor()` reads the ref, not the memo.** Both layers need it and
  the memo is a render behind — see the burst-typing note under the
  cells section.
- **A new overlay must decline in `onKey`.** `rowMenu` sits with
  `showProjects` / `picking` / `pickingOwner` at the top; a panel that
  runs its own input and forgets that line gets every keystroke twice.
- **And having declined, it must guarantee it can hand the keyboard
  back.** That line makes the app answer *nothing* while the panel is
  up, so focus leaving the panel is a keyboard that is simply dead —
  there is no handler left anywhere to hear `esc`, and the only way out
  is the mouse. `RowMenu` was reachable that way: thirteen buttons, and
  the fourteenth `Tab` landed on `<body>`. Trapping `Tab` fixes the
  route; `onBlur` closing the panel when focus lands outside it is the
  invariant, and is what a new overlay should copy. Test it by tabbing
  past the last control, not by tabbing once.

### The row menu is bounded by a rule, not by taste

`rowMenu.ts` holds the table and the argument; `check-rowmenu.ts` holds
it to it. **An item belongs there exactly when the mouse cannot already
reach the action, and every item names the key it runs.**

The failure this guards against is not someone adding a bad item — it is
someone adding a *direct gesture* and never coming back to delete the
menu entry it made redundant. So the check is against `DIRECT_GESTURES`,
a list in the same file: add a gesture to `TaskList` or `Gantt`, add its
command there, and the check tells you which menu item to drop. Skip
that step and the build fails rather than the menu quietly offering the
same thing twice in two places that will drift.

Two smaller things the check also pins, both of which have already been
got wrong once by hand: the hint has to *be* the command (a menu that
says `gp` and runs `gP` is worse than no hint), and `dd` / `s` / `u` have
to stay on it, since those three are the gap the menu was added to close.

**An item with one action *is* the row.** The hit target used to be the
key printed at the right end, which asked the pointer to aim past the
sentence it had just finished reading — the one thing a context menu
exists to spare it. So a one-action item renders as a single row-wide
`<button>`, and only the two-way items (priority, progress, nesting)
keep an inert label with two targets beside it, because a row that meant
both `>>` and `<<` would have to pick one. The consequence for anyone
adding an item: `RowMenu` walks the flat `WALK` list with
`at = walked + 1; walked += item.actions.length`, which is what keeps
the two branches in step and the lit element's `id` equal to what
`aria-activedescendant` names. That arithmetic holds for any number of
actions; what stops at two is `MenuItem.actions`, typed
`[MenuAction] | [MenuAction, MenuAction]`, and `check-rowmenu.ts`
asserting that a two-action item labels both sides. Widening that type
is the change that needs a third *layout*, not a third index.

**Labels are data, so `check-i18n.mjs` cannot see them by scanning call
sites.** It reads `label:` out of `rowMenu.ts` the way it already reads
`head:` / `title:` out of `dateColumns.ts`. Without that line the entire
menu ships in English inside a `ja` UI and nothing says so.

**There is no API to open the browser's own context menu.** A page can
only decline the event, which is what `⇧` does on a row — so an item
*inside* our menu could never offer it, and the footer says where it
went instead. Only rows and bars call `preventDefault` at all.

### The drop line is answered by the drop

`planDrop` in `App.tsx` runs `dropOrder` — the same function
`onDropRow` runs, over the same tasks — and reads the side out of the
order it returns. It does not decide which way the pointer is
travelling and infer from that, and the reason is worth keeping: the
inference is wrong exactly where nobody can check it. Dragging
*downwards* onto a sibling, the row's removal shifts the target up and
the row lands **below** it; dragging downwards onto a row at another
level, it takes the target's slot and lands **above** it. Same
gesture, opposite answers. Same rule as the gantt's move preview
clamping at `earliestStart`: a preview that disagrees with the commit
is worse than no preview.

`null` is "draw nothing", and it deliberately does not stop the drop.
A drop onto itself or into its own subtree, or any drop at all while
`:sort` is not `manual`, still runs and still says why in the status
line — silence is not an explanation, and `:sort manual` is the part
worth learning.

The line is placed from a measurement (`.row__lead`'s `offsetLeft`,
read once per row the drag crosses), not from the level times an
indent constant. It is indented because a drop takes the target's
*level* as well as its slot, and the first version of that sum — four
column widths and five flex gaps restated in CSS — was 14px wrong and
would have stayed wrong silently.

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

### Re-recording the README's demo gif

`cargo make demo-gif` records `assets/demo.gif` end to end — it starts a
release binary on a scratch `YAIBA_DATA_DIR`, seeds a plan over the API,
drives Chromium under playwright, and encodes. `cargo make demo-shots`
runs the same storyboard and writes one PNG per beat to
`target/demo-shots` instead, which is the loop for changing it; the
encode is the slow part and you rarely need it to see whether a beat
lands. Everything lives in `tools/demo/`, with its own `package.json` so
that `web-build` never installs a browser driver.

**Prerequisites: `bun`, `node` and `ffmpeg` on `PATH`.** The first two
are already what the web bundle needs; `ffmpeg` is the encoder and is
the one thing neither task can install for you — `demo-gif` says so and
stops if it is missing, and `demo-shots` never reaches it.

**The first run on a machine also downloads a browser** (~150MB), and
both tasks depend on `demo-deps`, which is where that happens. The
dependency there is `playwright-core` precisely *because* it downloads
nothing on install — that is what keeps a browser out of every release
build — so the browser is a second, explicit step:

```sh
cd tools/demo
bun install
node node_modules/playwright-core/cli.js install chromium   # no-op once present
```

Only needed if you run `node record.mjs` by hand; `cargo make demo-gif`
and `cargo make demo-shots` both run it for you. Skipping it fails inside
`chromium.launch` with a message about an executable path, so
`record.mjs` catches that one and says this instead.

The first gif was recorded by hand and nothing said how, which is why it
could not be updated when the UI grew past it. That is the point of the
task, so keep it working:

- **Run the recorder with `node`, not `bun`.** Playwright speaks CDP over
  extra stdio pipes on fd 3 and 4, and bun's `child_process` does not
  carry them. The browser launches, nothing ever connects, and it fails
  three minutes later with a launch timeout whose message points at the
  browser rather than at the pipe.
- **Capture frames, not video.** `recordVideo` writes VP8, and on a
  motionless screen VP8 still changes a pixel or two everywhere — which a
  gif cannot collapse, since it only knows "identical". The first take
  came out at 6.2MB, five of them compression noise over a screen where
  nothing was happening. `Page.startScreencast` with `format: png` gives
  the real pixels and only emits on paint, and the same storyboard
  encodes to about 600KB. The frames carry their own timestamps, so the
  gif ships variable delays rather than being resampled to a constant
  rate.
- **That last property stopped holding when the blade got effects.** A
  take used to be barely a hundred distinct pictures, because the UI
  painted on state changes rather than on a clock. A CSS animation *is*
  a clock: the 500ms shell wipe comes back as 32 frames about 10ms
  apart, and the storyboard has six such bursts now. A gif carries a
  delay per frame and the format's own floor is 10ms, so every one of
  them shipped — 289 frames and 1.7MB, against 109 and 610KB before.
  `MIN_GAP` in `record.mjs` drops frames closer together than 22ms,
  which is invisible at that speed and gives most of the difference
  back. It cannot touch a still beat, since those are one frame each
  already. Budget accordingly: a beat that *animates* costs frames on
  this scale, a beat that merely holds costs one.
- **Super mode is a different order of expense again, and it is the
  number to know before adding to that section.** Every other effect is
  a burst that ends; super mode's ambient half — the aurora, the roll,
  the flicker — never does, so the compositor paints for as long as the
  mode is on, and each of those frames differs over the *whole* screen
  rather than inside the box around a changed row. `diff_mode` has
  nothing to leave out: **about 48KB per frame, against 3KB for one in
  the rest of the take.** The first cut of the section ran fourteen
  seconds of super mode against a 55ms floor — 18 frames a second,
  already well short of `MIN_GAP` — and that stretch alone came to 9MB
  of a 10MB gif.
  That per-frame figure is a floor — a smaller palette, `hqdn3d`'s
  temporal denoise and posterising before `palettegen` were each tried
  and none of them moves it, because the drift is a level or two on
  nearly every pixel rather than noise in a few. The only knob is how
  many frames the section gets, which is what `pace` is: the storyboard
  marks `pace.stroke()` around the half-seconds where something is
  actually being drawn and `pace.drift()` over the rest, and `thin`
  reads the per-window floor. The take ships at about 4.9MB with ten
  seconds of super in it; that was a deliberate call, and it is the
  budget to spend against rather than one to quietly double.
- **Neither capture path draws the cursor**, so a mouse beat needs a
  pointer drawn into the page. Without one the divider slides with
  nothing touching it, which reads as an animation rather than a drag.
- **`⏎` on a new row opens the next one.** `o`, type, `⏎` leaves you in
  insert mode with a fresh draft, so a storyboard that carries on
  pressing normal-mode keys types them into a task title. `esc` is what
  commits and stops.
- **The drag leaves the grip holding the keyboard,** which is the
  behaviour `README.md` documents — so `h` / `l` move the divider, not
  the cell cursor, until something else takes focus. Click a row after
  dragging.
- **The gantt pane follows the cursor, and only the cursor.** An edge
  that moves a bar a fortnight out does not scroll the pane, because the
  effect is keyed on the cursor and the cursor did not move. `k` then `j`
  is the cheapest way to ask it to look again.
- **A pin that lands later than the scheduler's placement adds slack
  upstream**, and the critical path goes from magenta to nothing.
  Correct, and worth avoiding in a take: the calendar beat picks a
  planned *end* on a leaf instead, which extends the chain rather than
  loosening it.
- **The storyboard is a keybinding consumer like any other.** A key whose
  meaning moves — `x` off "done" and onto the cell, `V` off cells and
  onto rows — is a key the take may be pressing for the old reason. It
  will not fail; it will record the wrong thing. `demo-shots` after a
  keymap change is cheap, and is the only thing that catches it.

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
