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

import {
  cellColumns,
  cellEdit,
  cellKind,
  cellSpan,
  cellStep,
  cellWriteLine,
  actualsWriteFirst,
  pastePlan,
  type CellBlock,
  type CellField,
  type EditKey,
} from "../src/cells.ts";
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

// ---- which cell an edit key edits -----------------------------------
//
// The walk is only worth having if you can work where you walked to.
// `⏎` read the cell from the day the walk shipped; `i` / `a` did not,
// so `l l a` typed at a date opened the *title* — the bug this block
// exists to keep fixed.

/** `title:<caret><clear>`, `owner`, or `date:<field>`. */
function edit(key: EditKey, cell: CellField): string {
  const out = cellEdit(key, cell);
  if (out.kind === "title") {
    return `title:${out.caret}${out.clear ? " cleared" : ""}`;
  }
  return out.kind === "owner" ? "owner" : `date:${out.field}`;
}

check("a on a date opens that date", edit("a", "end"), "date:end");
check("i on a date opens it too", edit("i", "astart"), "date:astart");
check("A on the owner opens the owner", edit("A", "owner"), "owner");
check("and ⏎ agrees, on the same cell", edit("<cr>", "end"), "date:end");

// On the title the four still differ the only way they can.
check("i enters the title at the head", edit("i", "title"), "title:head");
check("I too", edit("I", "title"), "title:head");
check("a enters it at the tail", edit("a", "title"), "title:tail");
check("A too", edit("A", "title"), "title:tail");
check("⏎ enters what is there", edit("<cr>", "title"), "title:tail");

// `cc` follows the cursor like the rest of them. It is spelled after
// the `c` family, where each key names one field from anywhere, but it
// is not governed by it: on a cell, `cc` means *this* cell.
check("cc clears the title from the title", edit("cc", "title"), "title:tail cleared");
check("cc on a date opens that date", edit("cc", "aend"), "date:aend");
check("cc on the owner opens the owner", edit("cc", "owner"), "owner");

// With `gd` off there is one column, so every one of them is the title
// again — the same "compact is what it always was" the fold checks
// above assert for `h` / `l`.
const ONLY = cellColumns("compact")[0];
for (const key of ["i", "a", "<cr>", "cc"] as EditKey[]) {
  check(
    `compact ${key} edits the title`,
    cellEdit(key, ONLY).kind,
    "title",
  );
}
// A cell the columns stopped drawing never reaches here as itself:
// `App` clamps to the leftmost before calling, which in compact mode is
// the title — the same lock `cellStep` gets from the checks above.

// ---- the block yank (#87, second half) ------------------------------

// A rectangle is the same however it was dragged.
check("a span left to right", cellSpan("owner", "end", DATES).join(" "), "owner start end");
check("and the same dragged back", cellSpan("end", "owner", DATES).join(" "), "owner start end");
check("one cell is a span of one", cellSpan("start", "start", DATES).join(" "), "start");
check("compact spans its single column", cellSpan("title", "title", COMPACT).join(" "), "title");

// The kinds that decide whether a put lands.
check(
  "the four dates are one kind",
  [...new Set(["start", "end", "astart", "aend"].map((f) => cellKind(f as CellField)))].join(" "),
  "date",
);
check("a title is its own kind", cellKind("title"), "title");
check("an owner is its own kind", cellKind("owner"), "owner");

/** `from>to` per column, or `from>refusal`. */
function plan(cols: CellField[], at: CellField): string {
  const block: CellBlock = { cols, rows: [cols.map(() => null)] };
  return pastePlan(block, at, DATES)
    .map((p) => `${p.from}>${p.refused ?? p.to}`)
    .join(" ");
}

// The motivating case: the plan pair dropped onto the record pair.
check("start end lands on began ended", plan(["start", "end"], "astart"), "start>astart end>aend");
// Offset, so it keeps its shape wherever it is put.
check("and back the other way", plan(["astart", "aend"], "start"), "astart>start aend>end");
check("a single column lands where you point", plan(["aend"], "start"), "aend>start");

// Kinds that disagree are refused rather than coerced.
check("a title will not land on a date", plan(["title"], "start"), "title>different kind");
check("an owner will not either", plan(["owner"], "end"), "owner>different kind");
check("a title lands on a title", plan(["title"], "title"), "title>title");
// The block keeps its shape, so a pair straddling two kinds only half lands.
check(
  "a straddling pair lands only where the kinds agree",
  plan(["title", "owner"], "title"),
  "title>title owner>owner",
);
// Shifted by one, both halves land on a kind they are not: `owner` onto
// the title and `start` onto the owner. The block does not slide to find
// a fit — its shape is the thing being pasted.
check(
  "a block put where nothing fits refuses all of it",
  plan(["owner", "start"], "title"),
  "owner>different kind start>different kind",
);

// Running off the right edge is reported, never silently dropped.
check("a block wider than what is left", plan(["start", "end"], "aend"), "start>aend end>off the end");

// What each cell is written with. `end` is in here as a date command
// because `:end` is what turns it back into a duration — the paste must
// not do that arithmetic itself.
check("a date writes its own command", cellWriteLine("astart", "2026-07-31"), "astart 2026-07-31");
check("an empty date clears", cellWriteLine("aend", null), "aend none");
check("an owner goes through assign", cellWriteLine("owner", "mary"), "assign mary");
check("an empty owner clears", cellWriteLine("owner", null), "assign none");
check("a title goes through title", cellWriteLine("title", "Ship it"), "title Ship it");
// Nothing to write rather than a row left nameless.
check("an empty title writes nothing", String(cellWriteLine("title", null)), "null");

// ---- which of began / ended goes first (CodeRabbit, #102) ----------
//
// The two validate against each other, so a pasted span written in the
// wrong order half-lands: `:astart` is measured against an `actual_end`
// this same paste is about to replace. The regression that motivated
// this is the first check below.

// The reported bug: a August span onto a row still holding July.
check(
  "a later span writes its end first",
  actualsWriteFirst("2026-08-01", "2026-07-05"),
  "aend",
);
// The mirror: an earlier span is safe start-first, because the start
// lands before the finish already on the row.
check(
  "an earlier span writes its start first",
  actualsWriteFirst("2026-06-01", "2026-07-05"),
  "astart",
);
// Overlapping spans need no reordering.
check(
  "a start on the finish itself still goes first",
  actualsWriteFirst("2026-07-05", "2026-07-05"),
  "astart",
);
// Nothing to collide with.
check("no finish on the row", actualsWriteFirst("2026-08-01", null), "astart");
check("clearing the start", actualsWriteFirst(null, "2026-07-05"), "astart");

if (failures) {
  console.error(`\ncells: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`cells: ${ran} checks, all passing`);
