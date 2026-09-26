import type { Task, TaskId } from "./types";

/**
 * The per-task "hidden" flag, as a view rule.
 *
 * The flag is data (`Task.hidden`, synced like any field); what it *does*
 * lives here and nowhere else, so the list, the gantt and the counts
 * cannot disagree about which rows it takes off the screen. Scheduling
 * never reads it — a hidden task still holds its dates, its dependencies
 * and its place on the critical path.
 *
 * Pure and DOM-free so `check-hidden.ts` can run it.
 */

/** What the hidden stage did to a pool of rows. */
export interface HiddenStage {
  /** The rows that stay. */
  shown: Task[];
  /** Rows taken off the screen — a hidden task and its whole subtree. */
  dropped: Set<TaskId>;
}

/**
 * Take hidden rows, and everything under them, out of `pool`.
 *
 * A row goes when it or any ancestor carries the flag: hiding a parent
 * hides its subtree, since a child listed under an invisible parent has
 * no place to hang. The reverse never happens — a hidden child does not
 * take its parent with it, and this is applied *before* the filter query
 * so an ancestor the query pulls back in for context is by construction
 * one that survived here.
 *
 * `all` is the whole store, not the pool: an ancestor outside a focus is
 * still an ancestor, and its flag still counts.
 */
export function dropHidden(
  pool: Task[],
  all: Task[],
  showHidden: boolean,
): HiddenStage {
  if (showHidden) return { shown: pool, dropped: new Set() };
  const byId = new Map(all.map((t) => [t.id, t]));
  const gone = new Map<TaskId, boolean>();
  const isGone = (task: Task): boolean => {
    const known = gone.get(task.id);
    if (known !== undefined) return known;
    // Seeded first so a parent cycle from a bad merge terminates.
    gone.set(task.id, false);
    const parent = task.parent ? byId.get(task.parent) : undefined;
    const result = task.hidden || (parent ? isGone(parent) : false);
    gone.set(task.id, result);
    return result;
  };
  const dropped = new Set<TaskId>();
  const shown: Task[] = [];
  for (const task of pool) {
    if (isGone(task)) dropped.add(task.id);
    else shown.push(task);
  }
  return { shown, dropped };
}

/**
 * Where the cursor goes when its row leaves the screen.
 *
 * From its old place in `before` (the rows as they were drawn), the
 * nearest row still in `after` — looking down first, then up, the way
 * deleting a line in an editor leaves you on the one that slid into its
 * place. Null when the row was not in `before` or nothing is left.
 */
export function nearestVisible(
  before: TaskId[],
  after: TaskId[],
  cursorId: TaskId,
): TaskId | null {
  const at = before.indexOf(cursorId);
  if (at < 0) return null;
  const keep = new Set(after);
  for (let i = at + 1; i < before.length; i++) if (keep.has(before[i])) return before[i];
  for (let i = at - 1; i >= 0; i--) if (keep.has(before[i])) return before[i];
  return null;
}

/** Why the list has nothing to draw. */
export type EmptyReason = "none" | "filter" | "hidden";

/**
 * The empty state's wording, decided so "no tasks yet" is never said of a
 * plan that has tasks — they are only hidden.
 */
export function emptyReason(filter: string, hiddenCount: number): EmptyReason {
  if (filter) return "filter";
  return hiddenCount > 0 ? "hidden" : "none";
}
