/**
 * The plan-vs-actual columns, and what each cell reads from a task.
 *
 * Shared by the list — which draws them — and the app, which opens the
 * picker over one. Both have to agree on what a cell *means*: the value
 * shown, whether it was entered or computed, and whether it can be
 * edited at all. Two copies of that would drift into a picker offering
 * to clear a field the list is showing as derived.
 *
 * Editing goes back through `runCommand`, so nothing here validates a
 * date — `:start` / `:end` / `:astart` / `:aend` already do, and a
 * second opinion here would be the one that is wrong after the next
 * change.
 */

import type { DateField } from "./commands";
import type { Scheduled, Task } from "./types";

export interface DateColumn {
  field: DateField;
  /**
   * Column heading. The actuals are in the past tense because that is
   * what separates them: a plan is what will happen, a record is what
   * did.
   */
  head: string;
  /** Hover text on every cell in the column. */
  title: string;
  /**
   * `:<field> none` is legal. The plan's finish is not a stored field —
   * it is `start` + `duration_days` — so it has nothing to clear.
   */
  clearable: boolean;
  /**
   * A record rather than a plan. Carried as its own flag rather than
   * derived from the position, because the stylesheet needs it on every
   * actual cell: a sibling selector off the first one would out-specify
   * the states — empty, picking, locked — that have to win over it.
   */
  actual: boolean;
  /** First of the actuals, which is where the dividing rule goes. */
  opensActuals?: boolean;
}

export const DATE_COLUMNS: DateColumn[] = [
  {
    field: "start",
    head: "start",
    title: "planned start — dim means the scheduler placed it",
    clearable: true,
    actual: false,
  },
  {
    field: "end",
    head: "end",
    title: "planned finish — picking a date sets the duration",
    clearable: false,
    actual: false,
  },
  {
    field: "astart",
    head: "began",
    title: "when work actually began",
    clearable: true,
    actual: true,
    opensActuals: true,
  },
  {
    field: "aend",
    head: "ended",
    title: "when work actually finished",
    clearable: true,
    actual: true,
  },
];

/**
 * What the cell shows.
 *
 * The plan falls back to the scheduler's placement, because that is the
 * date the gantt draws and the one a reader is comparing against.
 * Blank there would hide the only answer the row has.
 */
export function dateValue(
  field: DateField,
  task: Task,
  sched: Scheduled | undefined,
): string | null {
  switch (field) {
    case "start":
      return task.start ?? sched?.start ?? null;
    case "end":
      return sched?.end ?? null;
    case "astart":
      return task.actual_start;
    case "aend":
      return task.actual_end;
  }
}

/**
 * Whether `:<field> none` is a thing this column can be told.
 *
 * The flag itself is on `DATE_COLUMNS`, where the picker reads it to
 * decide whether to draw a clear button. `x` on a cell asks the same
 * question from the grid, and asking it here rather than at the call
 * site is what keeps the two from drifting into a key that clears a
 * column the panel says is derived.
 *
 * An unknown field reads as not clearable, which is the safe way round:
 * the caller says so instead of writing a command the parser refuses.
 */
export function dateClearable(field: DateField): boolean {
  return DATE_COLUMNS.find((col) => col.field === field)?.clearable ?? false;
}

/**
 * What to call this column when telling the user about it.
 *
 * The heading, not the field: `astart` is drawn as `began` and
 * translated from there (`TaskList`, `t(col.head)`), so a message that
 * named the field would be pointing at a column that says something
 * else — in Japanese, at one that says 終了 while the message reads
 * `end`. Callers pass the result through `t()` the same way the heading
 * does. Falls back to the field so an unknown one still names itself.
 */
export function dateHead(field: DateField): string {
  return DATE_COLUMNS.find((col) => col.field === field)?.head ?? field;
}

/**
 * True when the value shown was computed rather than entered.
 *
 * Both halves of the plan hang off `start`: without a pin the task sits
 * on the day it was typed, as early as its dependencies allow, and the
 * finish follows it. Dimming both says nobody chose this date — so a
 * dependency slipping is free to carry it, where a pinned date would
 * have held and pushed the successor instead.
 *
 * It no longer means the date drifts on its own. It did while the anchor
 * was `today`, and "dim = this will have moved by tomorrow" is the
 * reading to unlearn.
 */
export function dateDerived(field: DateField, task: Task): boolean {
  return (field === "start" || field === "end") && task.start === null;
}

/**
 * Why this cell refuses an edit, or null when it takes one.
 *
 * `runCommand` refuses the same thing and says so on the status line;
 * this is what keeps the cell from *looking* editable first. The
 * actuals stay open on a summary: nothing rolls them up, so a date
 * typed on the parent is the only record there is.
 */
export function dateLocked(
  field: DateField,
  sched: Scheduled | undefined,
): string | null {
  if (!sched?.summary) return null;
  if (field === "astart" || field === "aend") return null;
  return "a summary's dates come from its children";
}
