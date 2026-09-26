/**
 * The hidden flag takes the rows it should off the screen, and no others.
 *
 * Client-side view rules type-check perfectly while being wrong, so this
 * runs the real `visibleView` and `nearestVisible`, the way
 * `check-folds.ts` does for folding. Run by `web-build`.
 *
 * Executed with `bun`, like the other checks.
 */

import { visibleTasks, visibleView, type ViewOptions } from "../src/filter.ts";
import { emptyReason, nearestVisible } from "../src/hidden.ts";
import type { Scheduled, Task } from "../src/types.ts";

interface Row {
  id: string;
  parent: string | null;
  hidden?: boolean;
  status?: Task["status"];
}

function plan(rows: Row[]): { tasks: Task[]; by: Map<string, Scheduled> } {
  const tasks: Task[] = rows.map((r, i) => ({
    id: r.id,
    parent: r.parent,
    title: r.id,
    notes: "",
    assignee: "",
    status: r.status ?? "todo",
    priority: 0,
    start: null,
    duration_days: 1,
    due: null,
    actual_start: null,
    actual_end: null,
    hidden: r.hidden ?? false,
    progress: 0,
    position: i,
    tags: [],
    created_at: "",
    updated_at: "",
    done_at: null,
  }));
  const by = new Map<string, Scheduled>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        start: "2026-08-01",
        end: "2026-08-01",
        slack_days: 0,
        critical: false,
        blocked: false,
        overdue: false,
        late: false,
        level: 0,
        summary: rows.some((c) => c.parent === r.id),
        progress: 0,
        children: 0,
      } as Scheduled,
    ]),
  );
  return { tasks, by };
}

const base: ViewOptions = {
  query: "",
  sort: "manual",
  collapsed: new Set(),
  focus: null,
  showHidden: false,
};

function ids(rows: Task[]): string {
  return rows.map((t) => t.id).join(" ") || "-";
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
  console.error(`FAIL  ${label}\n      got:  ${got}\n      want: ${want}`);
}

/**
 *   A            B     (A and B are roots)
 *   ├ A1
 *   │ └ A1a
 *   └ A2
 */
const tree = (over: Record<string, Partial<Row>> = {}): Row[] =>
  [
    { id: "A", parent: null },
    { id: "A1", parent: "A" },
    { id: "A1a", parent: "A1" },
    { id: "A2", parent: "A" },
    { id: "B", parent: null },
  ].map((r) => ({ ...r, ...over[r.id] }));

// ---- subtree rules ------------------------------------------------

{
  const { tasks, by } = plan(tree());
  check("nothing hidden lists everything", ids(visibleTasks(tasks, by, base)), "A A1 A1a A2 B");
}
{
  const { tasks, by } = plan(tree({ A1: { hidden: true } }));
  const view = visibleView(tasks, by, base);
  check("hiding a mid node takes its subtree with it", ids(view.rows), "A A2 B");
  check("the count includes the subtree", String(view.hiddenCount), "2");
}
{
  const { tasks, by } = plan(tree({ A: { hidden: true } }));
  const view = visibleView(tasks, by, base);
  check("hiding a parent hides all its descendants", ids(view.rows), "B");
  check("and counts them all", String(view.hiddenCount), "4");
}
{
  const { tasks, by } = plan(tree({ A1a: { hidden: true } }));
  check("hiding a child never hides its parent", ids(visibleTasks(tasks, by, base)), "A A1 A2 B");
}
{
  const { tasks, by } = plan(tree({ A1: { hidden: true }, A2: { hidden: true } }));
  check(
    "a parent whose children are all hidden shows with none",
    ids(visibleTasks(tasks, by, base)),
    "A B",
  );
}
{
  // A flagged row under a flagged parent is one row, not two, in the count.
  const { tasks, by } = plan(tree({ A: { hidden: true }, A1: { hidden: true } }));
  check(
    "nested flags are counted once per row",
    String(visibleView(tasks, by, base).hiddenCount),
    "4",
  );
}
{
  const { tasks, by } = plan(tree({ A1: { hidden: true } }));
  const shown = visibleView(tasks, by, { ...base, showHidden: true });
  check("show hidden lists every row", ids(shown.rows), "A A1 A1a A2 B");
  check("and nothing counts as hidden then", String(shown.hiddenCount), "0");
}

// ---- composition with the rest of the view ------------------------

{
  // The matching leaf is under a hidden parent: the query must not
  // bring the parent back for its sake.
  const { tasks, by } = plan(tree({ A1: { hidden: true } }));
  check(
    "a query does not resurrect a hidden ancestor",
    ids(visibleTasks(tasks, by, { ...base, query: "A1a" })),
    "-",
  );
  check(
    "a query still keeps the visible ancestors of a match",
    ids(visibleTasks(tasks, by, { ...base, query: "A2" })),
    "A A2",
  );
}
{
  const { tasks, by } = plan(tree({ A: { hidden: true } }));
  check(
    "a flat sort does not leak descendants of a hidden row",
    ids(visibleTasks(tasks, by, { ...base, sort: "title" })),
    "B",
  );
}
{
  // A focus below a hidden ancestor still honours that ancestor's flag.
  const { tasks, by } = plan(tree({ A: { hidden: true } }));
  check(
    "a focus inside a hidden subtree shows nothing",
    ids(visibleTasks(tasks, by, { ...base, focus: "A1" })),
    "-",
  );
  const outside = visibleView(tasks, by, { ...base, focus: "B" });
  check("the count is the focus's own", String(outside.hiddenCount), "0");
}
{
  const { tasks, by } = plan(tree({ A2: { hidden: true } }));
  check(
    "folds still apply on top",
    ids(visibleTasks(tasks, by, { ...base, collapsed: new Set(["A"]) })),
    "A B",
  );
}

// ---- cursor -------------------------------------------------------

{
  const before = ["A", "A1", "A1a", "A2", "B"];
  check(
    "cursor goes to the next row down",
    String(nearestVisible(before, ["A", "A2", "B"], "A1")),
    "A2",
  );
  check(
    "a hidden subtree is skipped on the way down",
    String(nearestVisible(before, ["A", "A2", "B"], "A1a")),
    "A2",
  );
  check("the last row falls back upward", String(nearestVisible(before, ["A", "A1"], "B")), "A1");
  check(
    "a row that was not on screen has no answer",
    String(nearestVisible(before, ["A"], "Z")),
    "null",
  );
  check("nothing left has no answer", String(nearestVisible(before, [], "A")), "null");
}

// ---- empty state --------------------------------------------------

{
  const { tasks, by } = plan([
    { id: "X", parent: null, hidden: true, status: "done" },
    { id: "Y", parent: null, hidden: true, status: "done" },
  ]);
  const view = visibleView(tasks, by, base);
  check("all rows hidden leaves an empty list", ids(view.rows), "-");
  check("with a count to say why", String(view.hiddenCount), "2");
  check("the empty state names the hidden rows", emptyReason("", view.hiddenCount), "hidden");
  check("a filter's own empty state wins", emptyReason("x", view.hiddenCount), "filter");
  check("a truly empty plan says none", emptyReason("", 0), "none");
}

if (failures) {
  console.error(`\nhidden: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`hidden: ${ran} checks, all passing`);
