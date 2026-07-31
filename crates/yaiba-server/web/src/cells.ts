/**
 * The column the cursor stands in, and where `h` / `l` take it.
 *
 * The list has always had one cursor, on a row. With the date columns up
 * a row is six cells wide, and "the cursor" stops being an answer: `cs`
 * / `ce` / `ca` / `cA` / `co` name a field each, which is five keys to
 * reach five cells and no way at all to walk them. Filling a roster down
 * a column meant the mouse, in a list where every other edit is a motion
 * plus a key (#87).
 *
 * So the cursor gains a second coordinate. What it must not do is cost
 * `h` / `l` their meaning: #82 gave them the fold a day before this, on
 * the argument that folding deserves one key like every other motion,
 * and a binding that changes under a display mode would be exactly the
 * "a display mode is a precondition for an edit" that AGENTS.md refuses.
 *
 * The way out is that both readings are the same motion. `h` is "back
 * out one step" and `l` is "go one step in" — nvim-tree's rule, which is
 * where #82 got the behaviour. A cell to the left is a step out. At the
 * leftmost column there is no cell left to back out to, so the step out
 * is the fold's, and that is where `foldStep` takes over. One rule, one
 * axis, and compact mode — which has a single column — never leaves the
 * arm that behaved this way before any of this existed.
 */

import type { Columns, DateField } from "./commands";
import { DATE_COLUMNS, dateValue } from "./dateColumns";
import type { Scheduled, Task } from "./types";

/**
 * A cell the cursor can stand in.
 *
 * `title` is not a column the eye sees as one — it is the row — but it
 * is where the cursor is when nothing else is chosen, and naming it
 * keeps the leftmost position from being a `null` that every caller has
 * to spell out a meaning for.
 */
export type CellField = "title" | "owner" | DateField;

/**
 * The cells on a row, left to right, in the mode currently drawn.
 *
 * Derived from `DATE_COLUMNS` rather than written out again, so a column
 * added there is one the cursor walks without a second edit — the same
 * bargain `TaskList` makes by mapping over it to draw them.
 *
 * `compact` has one. `due` and `prio` are on the row too, but they are
 * not columns: they sit inside the annotation run, whose length is
 * whatever the row happens to carry (`TaskList.tsx`, `row__lead`). A
 * cursor that stopped on them would be stopping somewhere different on
 * every row.
 */
export function cellColumns(columns: Columns): CellField[] {
  if (columns !== "dates") return ["title"];
  return ["title", "owner", ...DATE_COLUMNS.map((col) => col.field)];
}

/**
 * What `h` / `l` do from here.
 *
 * `fold` means the motion has run out of cells and the fold owns the
 * answer — the caller hands it to `foldStep`. `fallback` is where to go
 * if the fold declines: `l` on the title of a row that is not a closed
 * summary has nothing to open, and moving right is then the only reading
 * of "in" left. `null` is a motion at the edge, which does nothing
 * quietly, the way `l` on a leaf already did.
 */
export type CellStep =
  | { kind: "cell"; cell: CellField }
  | { kind: "fold"; fallback: CellField | null }
  | null;

export function cellStep(
  direction: "in" | "out",
  cell: CellField,
  cols: CellField[],
): CellStep {
  // A column that is no longer drawn reads as the leftmost, so a stale
  // cell cannot strand the motion. `App` clamps it before this is
  // called; this is the second lock on the hazard #87 named — a cursor
  // outliving the column it was standing in.
  const at = Math.max(0, cols.indexOf(cell));

  if (direction === "out") {
    if (at > 0) return { kind: "cell", cell: cols[at - 1] };
    return { kind: "fold", fallback: null };
  }

  // Going in from the leftmost cell is the fold's first, because that is
  // what it meant before there were cells to step through. Only once
  // there is nothing to open does the same key start walking columns.
  if (at === 0) return { kind: "fold", fallback: cols[1] ?? null };

  const next = cols[at + 1];
  return next ? { kind: "cell", cell: next } : null;
}

/**
 * What a cell holds, for the purpose of putting it somewhere else.
 *
 * A block yanked from `start end` and put on `began` has to land: they
 * are all dates and the whole point of the columns is comparing plan
 * against record. A title put on a date is not a near miss to be
 * coerced, it is a different kind of thing, and the paste says so rather
 * than writing something nobody asked for.
 *
 * Three groups rather than a per-pair table, because the answer is
 * always "same kind or refuse" and a table would invite exceptions.
 */
export type CellKind = "title" | "owner" | "date";

export function cellKind(cell: CellField): CellKind {
  return cell === "title" || cell === "owner" ? cell : "date";
}

/**
 * A yanked rectangle: the columns it came from, and a value per cell.
 *
 * Values are the raw field strings — what `dateValue` reads and what the
 * command line would take — not what the cell rendered. `07/31` is a
 * label; `2026-07-31` is the thing being copied.
 */
export interface CellBlock {
  cols: CellField[];
  /** `[row][col]`, same order and width as `cols`. */
  rows: (string | null)[][];
}

/**
 * The columns between two cells, inclusive, in screen order.
 *
 * Which of the two is the anchor does not matter — a selection dragged
 * leftwards covers the same cells as one dragged right.
 */
export function cellSpan(
  a: CellField,
  b: CellField,
  cols: CellField[],
): CellField[] {
  const i = Math.max(0, cols.indexOf(a));
  const j = Math.max(0, cols.indexOf(b));
  return cols.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** One column of a put: where a yanked column lands, or why it does not. */
export interface PastePair {
  from: CellField;
  to: CellField | null;
  /** Null when it lands; otherwise what stopped it. */
  refused: "off the end" | "different kind" | null;
}

/**
 * Where a block lands when put with the cursor on `at`.
 *
 * Offset, not by column identity: the block keeps its shape and the
 * cursor says where its top-left corner goes, which is what makes a
 * two-wide yank worth having. Landing `start end` on `began` is the
 * motivating case and it is exactly the one column identity would
 * refuse.
 *
 * Nothing is dropped silently. A block wider than the columns left of
 * the edge reports the overflow, and a column whose kind disagrees
 * reports that, so the caller can say which cells were skipped instead
 * of writing some of them and looking like it wrote all.
 */
export function pastePlan(
  block: CellBlock,
  at: CellField,
  cols: CellField[],
): PastePair[] {
  const start = Math.max(0, cols.indexOf(at));
  return block.cols.map((from, i) => {
    const to = cols[start + i];
    if (!to) return { from, to: null, refused: "off the end" as const };
    if (cellKind(from) !== cellKind(to)) {
      return { from, to, refused: "different kind" as const };
    }
    return { from, to, refused: null };
  });
}

/**
 * What a cell holds, as the value a command would take.
 *
 * The raw field, not the label the column draws: `2026-07-31` is the
 * thing being copied and `07/31` is a rendering of it. The dates go
 * through `dateValue`, so a `start` the scheduler placed yanks as the
 * date you can see rather than as blank — and pasting it therefore pins
 * it, which is a thing the caller has to say out loud.
 */
export function cellRead(
  cell: CellField,
  task: Task,
  sched: Scheduled | undefined,
): string | null {
  if (cell === "title") return task.title;
  if (cell === "owner") return task.assignee || null;
  return dateValue(cell, task, sched);
}

/**
 * The command line that writes `value` into `cell`.
 *
 * Every put runs one of these rather than patching the field, which is
 * the same bargain `commitDate` and `commitOwner` already make: `:end`
 * still measures a duration back from the date, an actual span is still
 * refused if it runs backwards, and a summary's plan is still refused.
 * A second implementation behind the paste would be the one that goes
 * stale the next time any of those change.
 *
 * `null` means the cell was empty. The dates and the owner take `none`
 * for that; a title does not, so an empty title has nothing to write and
 * the caller skips it rather than clearing a row's name.
 */
export function cellWriteLine(
  cell: CellField,
  value: string | null,
): string | null {
  if (cell === "title") return value ? `title ${value}` : null;
  if (cell === "owner") return `assign ${value ?? "none"}`;
  return `${cell} ${value ?? "none"}`;
}

/**
 * Which of `began` / `ended` a row must be given first.
 *
 * The two validate against each other: `:astart` refuses a date after
 * the `actual_end` already on the row, `:aend` refuses one before the
 * `actual_start` already on it. Write a pasted pair in the wrong order
 * and the first of them is measured against the value the second is
 * about to replace, so a perfectly good span half-lands — paste
 * `2026-08-01 .. 2026-08-10` onto a row still holding July and the
 * start is refused for being after a July finish that is on its way
 * out. That leaves the row with a new finish and its old start, which
 * is worse than refusing the whole thing.
 *
 * One of the two orders is always legal, and it is worth writing down
 * why. Call the pasted pair `(X, Y)` with `X <= Y` — it is a span, so
 * it is ordered — and the row's current pair `(a, b)`. Start-first
 * needs `X <= b`; end-first needs `Y >= a`. If both failed we would
 * have `X > b` and `Y < a`, hence `Y < a <= b < X`, so `Y < X` — which
 * contradicts the pair being a span. So testing one condition is
 * enough: when start-first would be refused, end-first cannot be.
 *
 * ISO dates compare correctly as strings, which is why this is a
 * comparison and not a date library.
 */
export function actualsWriteFirst(
  nextStart: string | null,
  currentEnd: string | null,
): "astart" | "aend" {
  // Nothing to collide with: an empty side constrains nothing, and
  // clearing a field is never refused for order.
  if (!nextStart || !currentEnd) return "astart";
  return nextStart > currentEnd ? "aend" : "astart";
}
