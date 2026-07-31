/**
 * The cell cursor walks the columns, and never at the fold's expense.
 *
 * Same argument as `check-folds.ts`, which #82 wrote for the same two
 * keys: this is a pure state transition, a wrong one type-checks
 * perfectly, and `cargo make check` is Rust-only. Run by `web-build`, so
 * it gates every PR through `web.yml`.
 *
 * The check that matters most is the last block. `h` / `l` shipped as
 * the fold one day before the cell cursor was written (#82, then #87),
 * and the whole design rests on compact mode coming out the other side
 * byte-identical. That is asserted here rather than promised in a
 * comment, because a later column added to `compact` would break it
 * silently otherwise.
 */

import { cellColumns, cellStep, type CellField } from "../src/cells.ts";
import { foldStep } from "../src/filter.ts";

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

// ---- what the cursor has to walk -----------------------------------

check(
  "compact is one column",
  cellColumns("compact").join(" "),
  "title",
);
check(
  "dates is the six the row draws",
  cellColumns("dates").join(" "),
  "title owner start end astart aend",
);

// ---- the step itself ------------------------------------------------

const DATES = cellColumns("dates");
const COMPACT = cellColumns("compact");

/** `cell:<field>`, `fold:<fallback>` or `-` when nothing happens. */
function step(
  direction: "in" | "out",
  cell: CellField,
  cols: CellField[],
): string {
  const out = cellStep(direction, cell, cols);
  if (!out) return "-";
  return out.kind === "cell" ? `cell:${out.cell}` : `fold:${out.fallback ?? "none"}`;
}

check("l from title offers the fold, then owner", step("in", "title", DATES), "fold:owner");
check("l from owner walks right", step("in", "owner", DATES), "cell:start");
check("l from start walks right", step("in", "start", DATES), "cell:end");
check("l at the last column does nothing", step("in", "aend", DATES), "-");

check("h from aend walks left", step("out", "aend", DATES), "cell:astart");
check("h from owner returns to the title", step("out", "owner", DATES), "cell:title");
// The one that keeps #82: at the leftmost cell `h` is the fold's, with
// no fallback — there is nothing to the left of the row itself.
check("h from title is the fold's alone", step("out", "title", DATES), "fold:none");

// A column that stopped being drawn must not strand the motion.
check("a stale cell reads as the leftmost", step("out", "aend", COMPACT), "fold:none");
check("and going in from one, too", step("in", "astart", COMPACT), "fold:none");

// ---- compact is exactly what #82 shipped ----------------------------
//
// Composed the way the key handler composes them: ask `cellStep` first,
// hand `fold` to `foldStep`, fall back only if the fold declines. With
// one column the first answer is always `fold`, so every h / l in
// compact mode reaches `foldStep` with nothing in front of it.

const ROW = { id: "A1", summary: false, parent: "A" };

function compactKey(key: "h" | "l", collapsed: Set<string>): string {
  const move = cellStep(key === "l" ? "in" : "out", "title", COMPACT);
  if (!move) return "-";
  if (move.kind === "cell") return `cell:${move.cell}`;
  const fold = foldStep(key === "l" ? "open" : "close", ROW, collapsed);
  if (fold) return `${[...fold.collapsed].sort().join(",")} | ${fold.cursor}`;
  return move.fallback ? `cell:${move.fallback}` : "-";
}

check(
  "compact h still closes the parent and moves there",
  compactKey("h", new Set()),
  "A | A",
);
check("compact l on a leaf still does nothing", compactKey("l", new Set()), "-");

// And the same composition in dates mode, on the title cell, is the same
// answer — the fold is not something `gd` turns off.
function datesKey(key: "h" | "l", collapsed: Set<string>): string {
  const move = cellStep(key === "l" ? "in" : "out", "title", DATES);
  if (!move) return "-";
  if (move.kind === "cell") return `cell:${move.cell}`;
  const fold = foldStep(key === "l" ? "open" : "close", ROW, collapsed);
  if (fold) return `${[...fold.collapsed].sort().join(",")} | ${fold.cursor}`;
  return move.fallback ? `cell:${move.fallback}` : "-";
}

check(
  "dates h on the title folds exactly as compact does",
  datesKey("h", new Set()),
  "A | A",
);
// The one behaviour the cell cursor adds to the title cell: `l` had
// nothing to open on a leaf and did nothing; now it walks into the
// columns instead.
check("dates l on a leaf walks into the columns", datesKey("l", new Set()), "cell:owner");
// A closed summary still spends the first `l` opening itself, which is
// the cost this design was chosen with eyes open — nvim-tree does the
// same, and the second `l` walks.
const SUMMARY = { id: "A", summary: true, parent: null };
const closed = new Set(["A"]);
const opening = cellStep("in", "title", DATES);
check(
  "a closed summary spends the first l opening",
  opening?.kind === "fold" && foldStep("open", SUMMARY, closed)
    ? "opens"
    : "walks",
  "opens",
);

if (failures) {
  console.error(`\ncells: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`cells: ${ran} checks, all passing`);
