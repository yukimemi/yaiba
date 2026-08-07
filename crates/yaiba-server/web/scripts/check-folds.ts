/**
 * Folding does what the keys say, checked against the real functions.
 *
 * The bug this guards against (#80) was pure client-side view state, and
 * the issue's own closing note is that nothing was ever going to catch
 * it: `cargo make check` is Rust-only, and `web.yml` type-checks the SPA
 * without executing it. A wrong *filter* type-checks perfectly.
 *
 * So this runs the filter. It is a script rather than a test suite for
 * the same reason `check-i18n.mjs` is one — the repo has no runner, and
 * adding one to assert two functions would cost more than it explains.
 * Run by `web-build`, so it gates every PR through `web.yml`.
 *
 * Executed with `bun`, which is already the installer here and runs
 * TypeScript with no flag. `node` needs `--experimental-strip-types`,
 * whose name says what depending on it in CI would be worth.
 */

import {
  collapsedForDepth,
  focusStep,
  foldStep,
  visibleTasks,
  type FoldView,
} from "../src/filter.ts";
import type { Scheduled, Task } from "../src/types.ts";

interface Row {
  id: string;
  parent: string | null;
  level: number;
  summary: boolean;
}

/**
 * Two projects, each a phase deep, each phase holding one leaf.
 *
 * Two of them because the bug was reported as "fold everything, then
 * look inside *one* thing" — a single tree cannot tell opening one
 * subtree apart from unfolding the world.
 */
const ROWS: Row[] = [
  { id: "A", parent: null, level: 0, summary: true },
  { id: "A1", parent: "A", level: 1, summary: true },
  { id: "A1a", parent: "A1", level: 2, summary: false },
  { id: "B", parent: null, level: 0, summary: true },
  { id: "B1", parent: "B", level: 1, summary: true },
  { id: "B1a", parent: "B1", level: 2, summary: false },
];

const tasks: Task[] = ROWS.map((r, i) => ({
  id: r.id,
  parent: r.parent,
  title: r.id,
  notes: "",
  assignee: "",
  status: "todo",
  priority: 0,
  start: null,
  duration_days: 1,
  due: null,
  actual_start: null,
  actual_end: null,
  progress: 0,
  position: i,
  tags: [],
  created_at: "",
  updated_at: "",
  done_at: null,
}));

const scheduled: Scheduled[] = ROWS.map((r) => ({
  id: r.id,
  start: "2026-08-01",
  end: "2026-08-01",
  slack_days: 0,
  critical: false,
  blocked: false,
  overdue: false,
  late: false,
  level: r.level,
  summary: r.summary,
  progress: 0,
  children: r.summary ? 1 : 0,
}));

const bySchedule = new Map(scheduled.map((s) => [s.id, s]));

/** The ids on screen, in order, with `collapsed` as the only fold state. */
function shown(collapsed: Set<string>): string {
  return visibleTasks(tasks, bySchedule, {
    query: "",
    sort: "manual",
    collapsed,
    focus: null,
  })
    .map((t) => t.id)
    .join(" ");
}

let ran = 0;
let failures = 0;

function check(label: string, got: string, want: string): void {
  ran++;
  if (got === want) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures++;
  console.error(`FAIL  ${label}\n        got  ${got}\n        want ${want}`);
}

function withoutFold(collapsed: Set<string>, id: string): Set<string> {
  const next = new Set(collapsed);
  next.delete(id);
  return next;
}

check("nothing folded shows every row", shown(new Set()), "A A1 A1a B B1 B1a");

// `zM` — fold to projects only.
const zM = collapsedForDepth(scheduled, 0);
check("zM leaves the projects", shown(zM), "A B");

// The bug itself. Before the fix a level cut hid these rows and
// `collapsed` was empty, so there was nothing for `za` to remove and the
// key did nothing at all.
const openA = withoutFold(zM, "A");
check("za on A after zM opens A", shown(openA), "A A1 B");
check("and again on A1, with B still folded", shown(withoutFold(openA, "A1")), "A A1 A1a B");

// The depths `zm` / `zr` / `:level n` step through.
check("depth 1 shows the phases", shown(collapsedForDepth(scheduled, 1)), "A A1 B B1");
check("depth 2 shows the leaves", shown(collapsedForDepth(scheduled, 2)), "A A1 A1a B B1 B1a");

// A leaf is never folded — folding one would hide nothing and draw a
// marker on a row that cannot open.
check(
  "only summaries are folded",
  [...collapsedForDepth(scheduled, 0)].sort().join(" "),
  "A A1 B B1",
);

// What the `▸` / `▾` marker reads. It renders from `collapsed` alone, so
// this equality is what keeps the marker and the list from disagreeing —
// the second symptom in #80, where every summary drew "open" after `zM`
// while its children were hidden.
check(
  "every hidden row has a folded ancestor in the set",
  ROWS.filter((r) => !shown(zM).split(" ").includes(r.id))
    .every((r) => {
      let at = r.parent;
      while (at) {
        if (zM.has(at)) return true;
        at = ROWS.find((x) => x.id === at)?.parent ?? null;
      }
      return false;
    })
    ? "yes"
    : "no",
  "yes",
);

// ---- what `h` and `l` decide (#82) ---------------------------------
//
// Same argument as everything above: this is a pure state transition, so
// leaving it to a keyboard nobody had that round would be leaving the one
// rule in this file that only a human can check.

const rowOf = (id: string) => {
  const r = ROWS.find((x) => x.id === id)!;
  return { id: r.id, summary: r.summary, parent: r.parent };
};

/** `<collapsed after> | <cursor after>`, or `-` when nothing happens. */
function step(direction: "open" | "close", id: string, collapsed: Set<string>): string {
  const out = foldStep(direction, rowOf(id), collapsed);
  if (!out) return "-";
  return `${[...out.collapsed].sort().join(",")} | ${out.cursor}`;
}

// `l` opens a closed summary, and does nothing else. Never a descent.
check("l opens a closed summary", step("open", "A", zM), "A1,B,B1 | A");
check("l on an open summary does nothing", step("open", "A", new Set()), "-");
check("l on a leaf does nothing", step("open", "A1a", new Set()), "-");

// `h` closes where you stand when there is something to close.
check("h closes an open summary", step("close", "A", new Set()), "A | A");

// The behaviour #82 asked to be deliberate: a leaf steps out to the
// parent and closes it, so `h` is usable as "back out of here".
check("h on a leaf closes the parent and moves there", step("close", "A1a", new Set()), "A1 | A1");
// And a summary that is already closed does the same, rather than nothing.
check(
  "h on a closed summary steps out too",
  step("close", "A1", new Set(["A1"])),
  "A,A1 | A",
);
// A project has no parent to back out to.
check("h at the top level does nothing", step("close", "A", new Set(["A"])), "-");

// The step is a value, not a mutation — the handler sets state from it,
// so a returned set that aliased the old one would make React skip the
// render and the key would look dead.
const before = new Set(["A1"]);
foldStep("close", rowOf("A1a"), before);
check("foldStep does not mutate what it is given", [...before].join(","), "A1");

// ---- what `zf` borrows and `zF` gives back (#135) -------------------
//
// The bug was that `zf` spent the fold state instead of borrowing it,
// and — because `collapsed` is persisted — spent the copy on disk too.
// Everything here is one `focusStep` chain, because the loss only shows
// up as a *pair*: dropping the folds on the way in is correct, and is
// indistinguishable from the bug until something comes back out.

/** `<collapsed> | <foldLevel> | <what a focus is holding>`. */
function view(v: FoldView): string {
  const saved = v.saved
    ? `${v.saved.collapsed.slice().sort().join(",") || "-"}@${v.saved.foldLevel}`
    : "-";
  return `${[...v.collapsed].sort().join(",") || "-"} | ${v.foldLevel} | ${saved}`;
}

/** A plan folded to its projects by `zM`, which is what `zf` displaces. */
const folded: FoldView = { collapsed: zM, foldLevel: 0, saved: null };

const focused = focusStep("in", folded);
check("zf opens the subtree fully", view(focused), "- | null | A,A1,B,B1@0");
check("zF puts the folds back", view(focusStep("out", focused)), "A,A1,B,B1 | 0 | -");

// The rule that keeps one `zF` enough: a second `zf` from inside a focus
// must not overwrite the memory with the empty set the first one just
// installed, or coming back out restores nothing.
const deeper = focusStep("in", focused);
check("a second zf keeps the first one's memory", view(deeper), "- | null | A,A1,B,B1@0");
check("and one zF still comes all the way back", view(focusStep("out", deeper)), "A,A1,B,B1 | 0 | -");

// Folding *inside* a focus is view state for the focus, not something to
// carry back out with it — `zF` restores, it does not merge.
const insideFocus: FoldView = { ...focused, collapsed: new Set(["A1"]) };
check("folds made inside a focus do not survive zF", view(focusStep("out", insideFocus)), "A,A1,B,B1 | 0 | -");

// With nothing to put back, the two ways out want opposite things — and
// the wrong one is the bug arriving by another door, since a `zF` that
// unfolded would take a hand-folded plan apart with no focus in sight.
check(
  ":all with nothing remembered shows everything",
  view(focusStep("out", folded, "unfold")),
  "- | null | -",
);
check(
  "zF with nothing remembered leaves the folds alone",
  view(focusStep("out", folded, "keep")),
  "A,A1,B,B1 | 0 | -",
);
// And where there *is* something to put back the two agree, which is
// what keeps `zF` and `:all` the same key in two spellings.
check(
  "the fallback does not reach a focus that borrowed",
  view(focusStep("out", focused, "keep")),
  view(focusStep("out", focused, "unfold")),
);

// Same argument as `foldStep` above: the handler sets state from the
// result, so a set carried through by reference would make React skip
// the render — and a `saved.collapsed` aliasing the live set would go on
// changing after the snapshot was taken.
const live = new Set(["A"]);
const borrowed = focusStep("in", { collapsed: live, foldLevel: 2, saved: null });
live.add("B");
check("the snapshot is a copy, not a view of the live set", borrowed.saved!.collapsed.join(","), "A");
check("focusStep does not mutate what it is given", [...live].sort().join(","), "A,B");

if (failures) {
  console.error(`\nfolds: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`folds: ${ran} checks, all passing`);
