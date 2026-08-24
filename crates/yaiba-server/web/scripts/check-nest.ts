/**
 * `>>` / `<<` shift a block one level and leave its shape alone.
 *
 * The bug this guards against was reported as "select several rows, press
 * `>>`, and they come out one level deeper each" — a staircase. Every
 * individual answer was right: the loop asked "what is the nearest
 * preceding row at my level" of the *pre-edit* tree, and for the second
 * selected sibling that row is the first selected sibling. Nothing about
 * it fails to type-check, and `cargo make check` is Rust-only, so the
 * only thing that was ever going to catch it is running the decision —
 * which is why the decision is a pure function and this script exists.
 *
 * Same shape as `check-folds.ts`: a script rather than a test suite
 * because the repo has no runner, run by `web-build` so it gates every
 * PR through `web.yml`, and executed with `bun` so TypeScript needs no
 * flag.
 */

import { nestMoves, type NestRow } from "../src/commands.ts";

/**
 * One project, four phases, two of them holding a leaf.
 *
 * Four siblings because the staircase needs three to be visible as a
 * staircase rather than as a single wrong answer, and the leaves are
 * what make "step over somebody else's children" and "a selected parent
 * carries its child" reachable at all.
 */
const ROWS: NestRow[] = [
  { id: "P", parent: null, level: 0 },
  { id: "A", parent: "P", level: 1 },
  { id: "A1", parent: "A", level: 2 },
  { id: "B", parent: "P", level: 1 },
  { id: "C", parent: "P", level: 1 },
  { id: "C1", parent: "C", level: 2 },
  { id: "D", parent: "P", level: 1 },
  { id: "Q", parent: null, level: 0 },
];

const PARENTS = new Map(ROWS.map((r) => [r.id, r.parent]));

let ran = 0;
let failures = 0;

function check(label: string, got: string, want: string): void {
  ran += 1;
  if (got === want) return;
  failures += 1;
  console.error(`FAIL ${label}\n  got:  ${got}\n  want: ${want}`);
}

/** `<id>→<new parent>` per move, in the order they are returned. */
function shift(
  direction: "in" | "out",
  selection: string[],
  rows: NestRow[] = ROWS,
  parents: Map<string, string | null> = PARENTS,
): string {
  const { moves } = nestMoves(direction, rows, selection, parents);
  return moves.length
    ? moves.map((m) => `${m.id}→${m.to ?? "-"}`).join(" ")
    : "-";
}

/** `<moves> / <rows that stayed>` — what the status line is built from. */
function counted(
  direction: "in" | "out",
  selection: string[],
  rows: NestRow[] = ROWS,
  parents: Map<string, string | null> = PARENTS,
): string {
  const { moves, stayed } = nestMoves(direction, rows, selection, parents);
  return `${moves.length} / ${stayed}`;
}

// ---- one row, which is the behaviour that was always right ---------

check("a row nests under the sibling above it", shift("in", ["C"]), "C→B");
// B's predecessor at its level is A, not A's child: a deeper row is
// somebody else's and is stepped over.
check("deeper rows are stepped over", shift("in", ["B"]), "B→A");
// Backwards from Q that means stepping over a whole subtree.
check("and so is a whole subtree", shift("in", ["Q"]), "Q→P");
// The first child of a parent has nothing at its own level above it. The
// scan stops at the shallower row rather than nesting under it, which
// would be a no-op the server would accept and nobody would see.
check("the first child has nowhere to go", shift("in", ["A"]), "-");
check("nor does the first project", shift("in", ["P"]), "-");

// ---- the bug: a block shifts uniformly ----------------------------

// The staircase was `B→A C→B D→C`. All three take the row above the
// *block*, so the three stay siblings of each other.
check("three siblings all land under the same anchor", shift("in", ["B", "C", "D"]), "B→A C→A D→A");
// Two of them, in case three hid an off-by-one.
check("two siblings do too", shift("in", ["C", "D"]), "C→B D→B");
// A selection is a set, not an order: the moves come out in display
// order whichever end the visual anchor was dropped on.
check("the order of the selection does not matter", shift("in", ["D", "C", "B"]), "B→A C→A D→A");

// A block whose first row cannot move is a block that cannot move.
// Before, the first row refused and the rest piled into it — the
// staircase again, one row shorter.
check("a block at the top of its level refuses entirely", shift("in", ["A", "B", "C"]), "-");
check("and so does one at the top level", shift("in", ["P", "Q"]), "-");

// ---- a selected row inside another one travels with it ------------

// C1 is C's child and is moving because C is. Re-parenting it as well
// would put it two levels down for one keypress.
check("a selected child is carried by its parent", shift("in", ["C", "C1"]), "C→B");
// The same rule from the other side: on `<<` the child would have been
// left behind as its parent's sibling.
check("and on the way out as well", shift("out", ["C", "C1"]), "C→-");
// Deeper than one level: A1's ancestor A is selected, so only A moves.
check("a grandchild is carried too", shift("in", ["B", "A", "A1"]), "-");

// ---- `<<`, which was already uniform and has to stay so -----------

check("a row moves out to its grandparent", shift("out", ["A1"]), "A1→P");
check("siblings all move out to the same place", shift("out", ["B", "C", "D"]), "B→- C→- D→-");
check("a project has nowhere to move out to", shift("out", ["P"]), "-");
check("and a whole block of them refuses", shift("out", ["P", "Q"]), "-");

// ---- a malformed graph is a state to survive ----------------------
//
// Two peers can close a parent loop concurrently, so neither walk may
// hang and neither may ask the server to make a row its own parent.

const LOOP_ROWS: NestRow[] = [
  { id: "X", parent: "Y", level: 1 },
  { id: "Y", parent: "X", level: 1 },
];
const LOOP_PARENTS = new Map<string, string | null>([
  ["X", "Y"],
  ["Y", "X"],
]);
check("a parent loop is refused, not walked forever", shift("out", ["X", "Y"], LOOP_ROWS, LOOP_PARENTS), "-");

const SELF_ROWS: NestRow[] = [{ id: "Z", parent: "Z", level: 1 }];
const SELF_PARENTS = new Map<string, string | null>([["Z", "Z"]]);
check("nor is a row made its own parent", shift("out", ["Z"], SELF_ROWS, SELF_PARENTS), "-");

// ---- what the status line is told (nothing lands silently) --------
//
// A selection can move in part: the first child of a parent, selected
// with two of its later siblings, shifts the two and leaves the one. A
// shift that said nothing there would be the silent half-landing
// `pasteCells` exists not to be — so the count of rows that stayed is
// part of the answer, not something `App` re-derives.
check("a mixed selection reports the row that stayed", counted("in", ["A", "C", "D"]), "2 / 1");
check("a shift that lands whole has nothing to report", counted("in", ["C", "D"]), "2 / 0");
// A carried descendant is neither a move nor a row that stayed: it went
// where its ancestor went. `moves.length` alone cannot say this, which
// is why the count is its own field.
check("a carried child is not counted as having stayed", counted("in", ["C", "C1"]), "1 / 0");
check("nor is a carried grandchild", counted("out", ["A", "A1"]), "1 / 0");
// Every row refusing is the refusal path, and `App` says so from the
// direction rather than from this count.
check("a whole block that cannot move counts every row", counted("in", ["A", "B", "C"]), "0 / 3");
check("moving out of the top level counts too", counted("out", ["P", "Q"]), "0 / 2");

// ---- what an undo puts back --------------------------------------
//
// The inverse is the parent the row had, read before anything moved —
// so a block undoes to the block it was, not to the staircase.
const undone = nestMoves("in", ROWS, ["B", "C", "D"], PARENTS)
  .moves.map((m) => `${m.id}→${m.from ?? "-"}`)
  .join(" ");
check("every move carries the parent it came from", undone, "B→P C→P D→P");

if (failures) {
  console.error(`\nnest: ${failures} of ${ran} checks failed`);
  process.exit(1);
}
console.log(`nest: ${ran} checks, all passing`);
