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
 * The whole manual order, rewritten so `id` sits `delta` **drawn rows**
 * further along, subtree in tow, taking whatever level that spot has.
 *
 * One press is one row on screen, which below the top level means the
 * level moves too: a row that has run out of siblings steps out to its
 * parent's level rather than stopping, and a row that meets an expanded
 * neighbour steps into it. Sibling-only movement — what `J` / `K` did —
 * made every crossing a manual `<<` / `>>` and back again, so reordering
 * a breakdown of any depth was a two-handed operation.
 *
 * `view` is what the screen currently shows: `open` are the rows whose
 * children are drawn, so a step never files the row inside something
 * folded, where it would move and vanish at the same time; `bound` is
 * the focused subtree, which the row may not climb out of for the same
 * reason.
 *
 * The level is only ever changed by a step that crosses a boundary, and
 * a step in the other direction undoes it exactly — `J` then `K` always
 * puts a row back where it started. Positions are re-stamped in tree
 * order, keeping the flat list and the drawn list telling the same story
 * for `o` / `O` to anchor against.
 *
 * `null` means the row could not move at all: it is already the first or
 * last row of the plan — or of the focused subtree — which are the only
 * walls left.
 */
export function stepOrder(
  tasks: Task[],
  id: TaskId,
  delta: number,
  view: { open: Set<TaskId>; bound: TaskId | null },
): { parent: TaskId | null; ids: TaskId[] } | null {
  const ids = new Set(tasks.map((t) => t.id));
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;

  const children = childBuckets(tasks);
  // Every other row keeps the parent it has — only `task` moves — so one
  // static map answers "whose child is this?" for the whole walk.
  const parentOf = new Map(tasks.map((t) => [t.id, effectiveParent(t, ids)]));
  const bucketOf = (parent: TaskId | null): Task[] => {
    const bucket = children.get(parent) ?? [];
    if (!children.has(parent)) children.set(parent, bucket);
    return bucket;
  };

  let parent = effectiveParent(task, ids);
  let moved = 0;
  const down = delta > 0;

  for (let n = Math.abs(delta); n > 0; n--) {
    const siblings = bucketOf(parent);
    const at = siblings.findIndex((t) => t.id === id);
    if (at < 0) break;
    const neighbour = siblings[down ? at + 1 : at - 1];

    if (neighbour) {
      const kids = children.get(neighbour.id) ?? [];
      siblings.splice(at, 1);
      if (kids.length && view.open.has(neighbour.id)) {
        // Into the neighbour: nearest end first, so the row lands on the
        // side of the subtree it arrived from and moves exactly one row.
        if (down) kids.unshift(task);
        else kids.push(task);
        parent = neighbour.id;
      } else {
        // A leaf, or a folded row whose subtree is drawn as one line:
        // stepping past it is a single row either way.
        siblings.splice(down ? at + 1 : at - 1, 0, task);
      }
    } else {
      // Out of siblings. At the root — or at the top of the subtree the
      // view is zoomed into — that is the end of the list; below it, the
      // row leaves its parent and lands beside it.
      if (parent === null || parent === view.bound) break;
      const above = parentOf.get(parent) ?? null;
      const uncles = bucketOf(above);
      const slot = uncles.findIndex((t) => t.id === parent);
      if (slot < 0) break;
      siblings.splice(at, 1);
      uncles.splice(down ? slot + 1 : slot, 0, task);
      parent = above;
    }
    moved++;
  }

  if (!moved) return null;
  return { parent, ids: flatten(tasks, children, null).map((t) => t.id) };
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
  /**
   * Every folded summary — the only thing that hides a row.
   *
   * There used to be a second axis here, a bare `foldLevel` depth, and
   * it was applied as a filter on every render: `level > foldLevel`
   * dropped the row before the `collapsed` check below could speak. So
   * after `zM` no `za` could open anything, because nothing was in
   * `collapsed` to remove — the level gate was hiding those rows, and
   * only `zr` could lift it, for every project at once. The depth now
   * *expands* into this set when a fold-to-level command runs (see
   * `foldToDepth`), which leaves one source of truth: the list, the
   * `▸`/`▾` marker and `za` all read the same thing and cannot disagree.
   */
  collapsed: Set<TaskId>;
  /** Show only this subtree, including the root itself. */
  focus: TaskId | null;
}

/**
 * The summaries to fold so that nothing deeper than `depth` is on screen.
 *
 * A summary *at* `depth` is folded, because what it hides is its children
 * at `depth + 1`. So `depth: 0` folds every summary and leaves the
 * projects, which is what `zM` means.
 */
export function collapsedForDepth(
  scheduled: Scheduled[],
  depth: number,
): Set<TaskId> {
  const out = new Set<TaskId>();
  for (const s of scheduled) if (s.summary && s.level >= depth) out.add(s.id);
  return out;
}

/** The row `foldStep` is being asked about. */
export interface FoldRow {
  id: TaskId;
  /** Has children, so it is something that can be folded at all. */
  summary: boolean;
  /** Its effective parent — where `h` steps out to. */
  parent: TaskId | null;
}

/**
 * Where `h` / `l` leave the fold state and the cursor.
 *
 * A pure function rather than two `case` arms in the key handler, so the
 * decision can be asserted without a DOM — `check-folds.ts` calls this
 * the same way it calls `collapsedForDepth`. The alternative is a rule
 * that only a real keyboard can check, which is how #80 shipped.
 *
 * `null` means nothing happens, which is a real answer here rather than
 * an error: `l` on a leaf and `h` at the top level both have nowhere to
 * go, and doing nothing quietly is what a motion at the edge of the tree
 * does everywhere else.
 */
export function foldStep(
  direction: "open" | "close",
  row: FoldRow,
  collapsed: Set<TaskId>,
): { collapsed: Set<TaskId>; cursor: TaskId } | null {
  if (direction === "open") {
    // Opening only ever opens. Descending into the subtree is `j`, and one
    // key meaning both would make it impossible to open a fold without
    // also leaving the row you opened.
    if (!row.summary || !collapsed.has(row.id)) return null;
    const next = new Set(collapsed);
    next.delete(row.id);
    return { collapsed: next, cursor: row.id };
  }

  // An open summary closes where you stand.
  if (row.summary && !collapsed.has(row.id)) {
    return { collapsed: new Set(collapsed).add(row.id), cursor: row.id };
  }
  // Anything else — a leaf, or a summary already closed — steps out and
  // closes the parent. That is what makes `h` mean "back out of here"
  // rather than dying on every row that happens not to be a fold.
  if (!row.parent) return null;
  return {
    collapsed: new Set(collapsed).add(row.parent),
    cursor: row.parent,
  };
}

/**
 * The fold state a focus is holding on to, as it is written to disk.
 *
 * A plain array and a number so it survives `JSON.stringify` into the
 * project's `ui` blob — the same shape `ProjectUiState.collapsed`
 * already has, and for the same reason: a `Set` serialises to `{}`.
 */
export interface FoldMemory {
  collapsed: TaskId[];
  foldLevel: number | null;
}

/** Everything `zf` and `zF` move between them. */
export interface FoldView {
  collapsed: Set<TaskId>;
  /** The depth `zm` / `zr` step from — see `foldLevelRef` in `App`. */
  foldLevel: number | null;
  /** What an outer focus displaced, or null when none is up. */
  saved: FoldMemory | null;
}

/**
 * What focusing and unfocusing do to the folds.
 *
 * `zf` has always dropped every fold, and that part is right: focusing a
 * project and being shown one closed row would be useless. What it did
 * *not* do was put them back, so the view you had built was spent rather
 * than borrowed — and since `collapsed` is persisted 500ms later, the
 * empty set it installed is what landed in the project database and a
 * reload recovered nothing (#135).
 *
 * Pure, and beside `foldStep` rather than inside the key handler, for
 * the reason that file's own comment gives: this is client-side view
 * state that type-checks perfectly while being wrong, so it belongs
 * somewhere `check-folds.ts` can run it.
 *
 * Two rules are worth stating, because both are ways to lose the folds
 * again:
 *
 *   - **Only the outermost `zf` remembers.** A second one from inside a
 *     focus would otherwise overwrite the memory with the empty set the
 *     first one just installed, and the `zF` that comes all the way back
 *     out would restore nothing.
 *   - **Leaving with nothing remembered still unfolds.** That is what
 *     `:all` on an unfocused plan means, and it is the only thing it can
 *     mean — there is no earlier view to go back to.
 */
export function focusStep(direction: "in" | "out", view: FoldView): FoldView {
  if (direction === "in") {
    return {
      collapsed: new Set(),
      foldLevel: null,
      saved:
        view.saved ??
        { collapsed: [...view.collapsed], foldLevel: view.foldLevel },
    };
  }
  if (!view.saved) return { collapsed: new Set(), foldLevel: null, saved: null };
  return {
    collapsed: new Set(view.saved.collapsed),
    foldLevel: view.saved.foldLevel,
    saved: null,
  };
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
  const { query, sort, collapsed, focus } = options;
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
  return ordered.filter(
    (task) => !ancestorsOf(task.id, byId).some((a) => collapsed.has(a)),
  );
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
