import type { Scheduled, Task, TaskId } from "./types";

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
 * Depth-first order: every task immediately followed by its subtree.
 *
 * Siblings keep the server's `position` order, which is what `J` / `K`
 * rewrite, so moving a row moves it within its own parent.
 */
export function treeOrder(tasks: Task[], root: TaskId | null = null): Task[] {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map<TaskId | null, Task[]>();
  for (const task of tasks) {
    // Matches the server's rule: a parent that isn't here leaves the
    // child at the root instead of hiding it.
    const parent = task.parent && ids.has(task.parent) ? task.parent : null;
    const bucket = children.get(parent);
    if (bucket) bucket.push(task);
    else children.set(parent, [task]);
  }

  const out: Task[] = [];
  const seen = new Set<TaskId>();
  const walk = (parent: TaskId | null) => {
    for (const task of children.get(parent) ?? []) {
      // A parent cycle that survived a merge must not loop forever.
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      out.push(task);
      walk(task.id);
    }
  };
  walk(root);

  // Anything stranded by a cycle still gets rendered, at the end.
  for (const task of tasks) if (!seen.has(task.id)) out.push(task);
  return out;
}

/** Every ancestor of `id`, nearest first. */
export function ancestorsOf(id: TaskId, byId: Map<TaskId, Task>): TaskId[] {
  const out: TaskId[] = [];
  let current = byId.get(id)?.parent ?? null;
  while (current && !out.includes(current)) {
    out.push(current);
    current = byId.get(current)?.parent ?? null;
  }
  return out;
}

export interface ViewOptions {
  query: string;
  sort: SortKey;
  /** Rows the user folded individually. */
  collapsed: Set<TaskId>;
  /** Hide anything deeper than this. `null` shows every level. */
  foldLevel: number | null;
  /** Show only this subtree, including the root itself. */
  focus: TaskId | null;
}

/**
 * The rows actually on screen.
 *
 * Order is the breakdown itself unless an explicit sort is active, in
 * which case the tree is flattened — a list sorted by due date has no
 * meaningful nesting left to draw.
 *
 * Filtering keeps the ancestors of every match. A matching leaf shown
 * without its parents loses the context that says which project it is
 * in, which is the whole point of having a breakdown.
 */
export function visibleTasks(
  tasks: Task[],
  bySchedule: Map<TaskId, Scheduled>,
  options: ViewOptions,
): Task[] {
  const { query, sort, collapsed, foldLevel, focus } = options;
  const byId = new Map(tasks.map((t) => [t.id, t]));

  let pool = tasks;
  if (focus) {
    const inFocus = (task: Task) =>
      task.id === focus || ancestorsOf(task.id, byId).includes(focus);
    pool = tasks.filter(inFocus);
  }

  if (query) {
    const keep = new Set<TaskId>();
    for (const task of pool) {
      if (!matches(task, bySchedule.get(task.id), query)) continue;
      keep.add(task.id);
      for (const ancestor of ancestorsOf(task.id, byId)) keep.add(ancestor);
    }
    pool = pool.filter((t) => keep.has(t.id));
  }

  if (sort !== "manual") return flatSorted(pool, bySchedule, sort);

  const ordered = treeOrder(pool, focus ? null : null);
  return ordered.filter((task) => {
    const level = bySchedule.get(task.id)?.level ?? 0;
    if (foldLevel !== null && level > foldLevel) return false;
    return !ancestorsOf(task.id, byId).some((a) => collapsed.has(a));
  });
}

function flatSorted(
  tasks: Task[],
  bySchedule: Map<TaskId, Scheduled>,
  sort: SortKey,
): Task[] {
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
      case "manual":
        return task.position;
    }
  };

  return [...tasks].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    // Stable tail-break so the list never reshuffles under the cursor.
    return a.position - b.position;
  });
}
