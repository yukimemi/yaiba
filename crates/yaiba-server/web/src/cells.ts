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
import { DATE_COLUMNS } from "./dateColumns";

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
