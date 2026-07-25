import type { Scheduled, Task } from "./types";

export type SortKey =
  | "manual"
  | "due"
  | "prio"
  | "start"
  | "title"
  | "status";

export const SORT_KEYS: SortKey[] = [
  "manual",
  "due",
  "prio",
  "start",
  "title",
  "status",
];

const STATUS_ORDER = { doing: 0, todo: 1, done: 2 } as const;

/**
 * Filter query grammar, space separated and ANDed:
 *
 *   `tag:dev`      has that tag
 *   `status:todo`  exact status
 *   `open`         anything not done
 *   `done`         completed
 *   `crit`         on the critical path
 *   `blocked`      waiting on an unfinished predecessor
 *   `overdue`      projected to finish past its due date
 *   `-<term>`      negates any of the above, or a text match
 *   anything else  case-insensitive substring of the title
 */
export function matches(
  task: Task,
  scheduled: Scheduled | undefined,
  query: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((raw) => {
    const negated = raw.startsWith("-") && raw.length > 1;
    const term = negated ? raw.slice(1) : raw;
    const hit = matchTerm(task, scheduled, term);
    return negated ? !hit : hit;
  });
}

function matchTerm(
  task: Task,
  scheduled: Scheduled | undefined,
  term: string,
): boolean {
  if (term.startsWith("tag:")) {
    const want = term.slice(4).replace(/^#/, "");
    return task.tags.some((t) => t.toLowerCase() === want);
  }
  if (term.startsWith("status:")) return task.status === term.slice(7);
  if (term === "open") return task.status !== "done";
  if (term === "done") return task.status === "done";
  if (term === "doing") return task.status === "doing";
  if (term === "crit") return scheduled?.critical ?? false;
  if (term === "blocked") return scheduled?.blocked ?? false;
  if (term === "overdue") return scheduled?.overdue ?? false;
  return (
    task.title.toLowerCase().includes(term) ||
    task.notes.toLowerCase().includes(term) ||
    task.tags.some((t) => t.toLowerCase().includes(term))
  );
}

/**
 * The rows actually on screen: filtered, then ordered.
 *
 * `manual` keeps the server's `position` order — the one `J` / `K` and
 * `:sort manual` restore — so it is the only ordering where moving a
 * row means anything.
 */
export function visibleTasks(
  tasks: Task[],
  bySchedule: Map<string, Scheduled>,
  query: string,
  sort: SortKey,
): Task[] {
  const rows = query
    ? tasks.filter((t) => matches(t, bySchedule.get(t.id), query))
    : [...tasks];

  if (sort === "manual") return rows;

  const key = (task: Task): string | number => {
    switch (sort) {
      case "due":
        // Undated tasks sort last rather than first.
        return task.due ?? "9999-12-31";
      case "start":
        return bySchedule.get(task.id)?.start ?? "9999-12-31";
      case "prio":
        return -task.priority;
      case "title":
        return task.title.toLowerCase();
      case "status":
        return STATUS_ORDER[task.status];
    }
  };

  return rows.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    // Stable tail-break so the list never reshuffles under the cursor.
    return a.position - b.position;
  });
}
