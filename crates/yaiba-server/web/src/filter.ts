import type { Scheduled, Task, TaskId } from "./types";

export type SortKey =
  | "manual"
  | "due"
  | "prio"
  | "start"
  | "title"
  | "status"
  | "owner";

export const SORT_KEYS: SortKey[] = [
  "manual",
  "due",
  "prio",
  "start",
  "title",
  "status",
  "owner",
];

const STATUS_ORDER = { doing: 0, todo: 1, done: 2 } as const;

/**
 * Filter query grammar, space separated and ANDed:
 *
 *   `tag:dev`      has that tag
 *   `@yuki`        assigned to that person (`owner:yuki` reads the same)
 *   `unassigned`   nobody has taken it — `@` on its own does too
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
  // `@yuki` and `owner:yuki` are one term with two spellings: `@` is
  // what the row shows, `owner:` is what the `tag:`-shaped half of this
  // grammar leads you to try. Matching is exact and case-insensitive —
  // a substring would make `@sato` also answer for `@satoshi`, and the
  // one thing a per-person view has to be is complete.
  //
  // One token, because this grammar has already split on whitespace by
  // the time it gets here. That is why `:assign` refuses a name with a
  // space rather than teaching this line to unquote one.
  if (term.startsWith("@") || term.startsWith("owner:")) {
    const want = term.startsWith("@") ? term.slice(1) : term.slice(6);
    if (!want || want === "none") return !task.assignee;
    return task.assignee.toLowerCase() === want;
  }
  if (term === "unassigned") return !task.assignee;
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
    task.assignee.toLowerCase().includes(term) ||
    task.tags.some((t) => t.toLowerCase().includes(term))
  );
}

/**
 * The parent a task is actually drawn under.
 *
 * Matches the server's rule: a parent that isn't in this list leaves the
 * child at the root instead of hiding it.
 */
export function effectiveParent(task: Task, ids: Set<TaskId>): TaskId | null {
  return task.parent && ids.has(task.parent) ? task.parent : null;
}

/** Tasks grouped by their effective parent, each bucket in list order. */
function childBuckets(tasks: Task[]): Map<TaskId | null, Task[]> {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map<TaskId | null, Task[]>();
  for (const task of tasks) {
    const parent = effectiveParent(task, ids);
    const bucket = children.get(parent);
    if (bucket) bucket.push(task);
    else children.set(parent, [task]);
  }
  return children;
}

/** Walk the buckets depth-first from `root`, then append anything stranded. */
function flatten(
  tasks: Task[],
  children: Map<TaskId | null, Task[]>,
  root: TaskId | null,
): Task[] {
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

/**
 * Depth-first order: every task immediately followed by its subtree.
 *
 * Siblings keep the server's `position` order, which is what `J` / `K`
 * rewrite, so moving a row moves it within its own parent.
 */
export function treeOrder(tasks: Task[], root: TaskId | null = null): Task[] {
  return flatten(tasks, childBuckets(tasks), root);
}

/**
 * The whole manual order, rewritten so `id` sits `delta` places further
 * along **among its own siblings**, subtree in tow.
 *
 * Swapping two neighbours in the flat `position` list — which is what
 * `J` / `K` used to do — is invisible the moment the breakdown has more
 * than one level: the row above may be a child of something else, and
 * the tree walk re-groups it by parent afterwards, restoring exactly the
 * order that was just rewritten. Sibling order is the only order the
 * list actually draws, so that is the one to rewrite; positions are then
 * re-stamped in tree order, which keeps the flat list and the drawn list
 * telling the same story for `o` / `O` to anchor against.
 *
 * `null` means the row is already the first or last of its siblings —
 * there is nowhere to go without changing its level.
 */
export function siblingOrder(
  tasks: Task[],
  id: TaskId,
  delta: number,
): TaskId[] | null {
  const children = childBuckets(tasks);
  const ids = new Set(tasks.map((t) => t.id));
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;

  const siblings = children.get(effectiveParent(task, ids)) ?? [];
  const from = siblings.findIndex((t) => t.id === id);
  if (from < 0) return null;
  const to = Math.min(Math.max(from + delta, 0), siblings.length - 1);
  if (from === to) return null;

  siblings.splice(to, 0, ...siblings.splice(from, 1));
  return flatten(tasks, children, null).map((t) => t.id);
}

/**
 * Where a row dropped onto `targetId` lands: `target`'s slot, as its
 * sibling, with the dragged row's own subtree in tow.
 *
 * The drop used to splice the flat `position` list, which below the top
 * level moves a row past somebody else's child and leaves the drawn
 * order untouched — the same silent no-op `J` / `K` had. Taking the
 * target's *slot* is what the gesture looks like: you dropped the row
 * where that one is, so that is where it goes, at that one's level.
 *
 * `null` when the drop cannot happen: an unknown row, itself, or a
 * target inside the dragged row's own subtree, which would ask a task
 * to become its own descendant.
 */
export function dropOrder(
  tasks: Task[],
  id: TaskId,
  targetId: TaskId,
): { parent: TaskId | null; ids: TaskId[] } | null {
  if (id === targetId) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const task = byId.get(id);
  const target = byId.get(targetId);
  if (!task || !target) return null;
  if (ancestorsOf(targetId, byId).includes(id)) return null;

  const ids = new Set(tasks.map((t) => t.id));
  const children = childBuckets(tasks);
  const parent = effectiveParent(target, ids);

  const from = children.get(effectiveParent(task, ids)) ?? [];
  const to = children.get(parent) ?? [];
  const at = from.findIndex((t) => t.id === id);
  // The target's slot is read *before* the row is lifted out, which is
  // what makes a drag read the same way in both directions when the two
  // rows are siblings: dropping downwards, the removal shifts everything
  // past it up by one, so the row lands below the target; dropping
  // upwards nothing shifts and it lands above. Taking the index
  // afterwards puts a downward drag back exactly where it started.
  const slot = to.findIndex((t) => t.id === targetId);
  if (at < 0 || slot < 0) return null;
  from.splice(at, 1);
  to.splice(slot, 0, task);

  return { parent, ids: flatten(tasks, children, null).map((t) => t.id) };
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
      case "owner":
        // Unowned rows sort last, the same way undated ones do: the
        // point of the order is to read one person's work in a block,
        // and a wall of blanks at the top buries every block below it.
        // `￿` beats any real name without special-casing the sort.
        return task.assignee.toLowerCase() || "￿";
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
