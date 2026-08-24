/**
 * What a row yank takes, and what a put re-draws — checked against the
 * real functions.
 *
 * Every rule here is invisible to `tsc`: the block is a value computed
 * from the plan, and the two ways of getting it wrong (a summary copied
 * without the children a fold is hiding, a copied phase whose internal
 * ordering was dropped) both compile perfectly and both produce a plan
 * that looks plausible on screen. A keyboard is the only other way to
 * find them, and there is not one in CI.
 */

import { copiedDeps, rowBlock } from "../src/rows.ts";
import type { Dep, Task } from "../src/types.ts";

interface Row {
  id: string;
  parent: string | null;
}

/**
 * Two phases under one project, each holding two leaves, plus a
 * bystander at the root — so "everything" and "the subtree" are
 * different answers.
 */
const ROWS: Row[] = [
  { id: "A", parent: null },
  { id: "A1", parent: "A" },
  { id: "A1a", parent: "A1" },
  { id: "A1b", parent: "A1" },
  { id: "A2", parent: "A" },
  { id: "A2a", parent: "A2" },
  { id: "B", parent: null },
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
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  done_at: null,
}));

const byId = new Map(tasks.map((t) => [t.id, t]));
const pick = (...ids: string[]): Task[] => ids.map((id) => byId.get(id)!);

/** An edge inside the subtree, one leaving it, and one wholly outside. */
const deps: Dep[] = [
  { from: "A1a", to: "A1b", lag_days: 0 },
  { from: "A1b", to: "A2a", lag_days: 3 },
  { from: "A2a", to: "B", lag_days: 1 },
  { from: "B", to: "A", lag_days: 1 },
];

let ran = 0;
let failures = 0;

function check(label: string, got: string, want: string): void {
  ran += 1;
  if (got === want) return;
  failures += 1;
  console.error(`FAIL ${label}\n  got  ${got}\n  want ${want}`);
}

/** `<ids in order> | <edges in order>`, from a plan and a fold state. */
function block(pool: Task[], roots: Task[], closed: string[] = []): string {
  const b = rowBlock(pool, deps, roots, new Set(closed));
  return [
    b.tasks.map((t) => t.id).join(" ") || "-",
    b.deps.map((d) => `${d.from}>${d.to}+${d.lag_days}`).join(" ") || "-",
  ].join(" | ");
}

// The ask itself, and the rule: a *closed* fold is one row to an
// operator, so `yy` / `dd` on it take the subtree. Same block for both
// keys — the fold state is the only thing consulted.
check(
  "a closed summary takes its subtree",
  block(tasks, pick("A1"), ["A1"]),
  "A1 A1a A1b | A1a>A1b+0",
);
check(
  "a closed project takes everything under it",
  block(tasks, pick("A"), ["A"]),
  "A A1 A1a A1b A2 A2a | A1a>A1b+0 A1b>A2a+3",
);

// Open, it is the row it is standing on. The children are on screen, so
// they are rows the gesture did not point at — the reading `zr` then
// `yy` has to have, and what a `dd` there leaves is orphans drawn at the
// root, one `u` away.
check("an open summary is the row alone", block(tasks, pick("A1")), "A1 | -");
check(
  "an open project too, however deep it is",
  block(tasks, pick("A")),
  "A | -",
);
// The distinction is the fold state and not the row: same selection,
// two answers.
check(
  "folding it is the whole difference",
  block(tasks, pick("A2"), ["A2"]),
  "A2 A2a | -",
);

// A leaf is never folded, so it is always itself.
check("a leaf yanks as itself", block(tasks, pick("A1a")), "A1a | -");
check(
  "and a leaf listed as closed changes nothing",
  block(tasks, pick("A1a"), ["A1a"]),
  "A1a | -",
);

// A fold inside a closed fold changes nothing: the outer one already
// took everything under it.
check(
  "a nested fold adds nothing to a closed parent",
  block(tasks, pick("A"), ["A", "A1"]),
  "A A1 A1a A1b A2 A2a | A1a>A1b+0 A1b>A2a+3",
);
// And a closed child below an *open* parent is not reached at all —
// nothing selected it.
check(
  "a closed child of an open parent stays out",
  block(tasks, pick("A"), ["A1"]),
  "A | -",
);

// A visual selection routinely holds both. Taking the subtree twice
// would paste the children a second time under their own copies.
check(
  "a parent and its child selected together are one block",
  block(tasks, pick("A1", "A1a"), ["A1"]),
  "A1 A1a A1b | A1a>A1b+0",
);

// Order is the plan's tree walk, not the selection's — a put creates
// rows one at a time and re-parents onto the copy of the parent.
check(
  "the block is in tree order however it was selected",
  block(tasks, pick("A2", "A1"), ["A1", "A2"]),
  "A1 A1a A1b A2 A2a | A1a>A1b+0 A1b>A2a+3",
);

// Edges are a question about two endpoints: an edge leaving the block
// has nowhere to land, so it is not carried.
check(
  "an edge with one end outside the block is dropped",
  block(tasks, pick("A2"), ["A2"]),
  "A2 A2a | -",
);
check("a block of one leaf carries no edges", block(tasks, pick("B")), "B | -");

// What a delete leaves, which is the other half of the fold rule: a
// closed summary must take its children with it, because `collapsed`
// still holds the dead id and `ancestorsOf` would filter every orphan
// off the list — present in the plan and reachable only by `zR`.

/** Tasks left behind whose parent went with the block. */
function orphans(roots: Task[], closed: string[]): string {
  const gone = new Set(
    rowBlock(tasks, deps, roots, new Set(closed)).tasks.map((t) => t.id),
  );
  return (
    tasks
      .filter((t) => !gone.has(t.id) && t.parent && gone.has(t.parent))
      .map((t) => t.id)
      .join(" ") || "-"
  );
}

check("deleting a closed summary hides no orphan", orphans(pick("A1"), ["A1"]), "-");
check("nor does deleting a closed project", orphans(pick("A"), ["A"]), "-");
check("nor two closed summaries at once", orphans(pick("A1", "A2"), ["A1", "A2"]), "-");
// Open, the orphans are the point: they are drawn at the root, which is
// what deleting a heading does anywhere else.
check("an open summary leaves its children visible", orphans(pick("A1"), []), "A1a A1b");

// A parent cycle two peers can merge into existence must not hang the
// walk. `treeOrder` strands both rows at the end of its own order,
// which is what the list already draws.
const cyclic: Task[] = [
  { ...byId.get("A1a")!, parent: "A1b" },
  { ...byId.get("A1b")!, parent: "A1a" },
];
check(
  "a parent cycle terminates",
  block(cyclic, [cyclic[0]], ["A1a", "A1b"]),
  "A1a A1b | A1a>A1b+0",
);

// ---- what a put re-draws -------------------------------------------

const yanked = rowBlock(tasks, deps, pick("A"), new Set(["A"]));
const copies = new Map(yanked.tasks.map((t) => [t.id, `${t.id}'`]));

/** The edges a put files, in order. */
function drawn(map: Map<string, string>): string {
  return (
    copiedDeps(yanked, map)
      .map((d) => `${d.from}>${d.to}+${d.lag_days}`)
      .join(" ") || "-"
  );
}

// Both endpoints re-pointed at the copies, and the lag along with them:
// an edge that quietly became the default spacing would move the copy's
// dates, which is the one thing a duplicate must not do.
check("every internal edge is re-drawn between copies", drawn(copies), "A1a'>A1b'+0 A1b'>A2a'+3");

// A row that failed to create leaves its edge with nowhere to land.
// Pointing it at the original would tie the copy back into the block it
// came from — a shape the yank never had.
const partial = new Map(copies);
partial.delete("A2a");
check("an edge whose endpoint failed to copy is dropped", drawn(partial), "A1a'>A1b'+0");
check("with no copies at all, nothing is drawn", drawn(new Map()), "-");

if (failures) {
  console.error(`rows: ${failures} of ${ran} checks failed`);
  process.exit(1);
}
console.log(`rows: ${ran} checks, all passing`);
