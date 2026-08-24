/**
 * What the row register holds, and how a put rebuilds it.
 *
 * The sibling of `cells.ts`: that module owns the rectangle `y` fills,
 * this one owns the block `yy` / `Y` / `dd` fill. Both are here rather
 * than in `App.tsx` so `web-build` can run them — see `check-rows.ts`.
 *
 * **A closed fold is one row to an operator.** Vim's rule, and the
 * whole rule here: `yy` / `dd` on a *closed* summary take the subtree
 * under it, and on an open one take the row they are standing on. A
 * row's own children are on screen when the fold is open, so acting on
 * the group would be acting on rows the gesture did not point at; when
 * it is closed they are not, and a summary alone is not a thing anyone
 * meant to copy — its dates are the union of its children's and its
 * progress is their roll-up, so the copy would have no dates at all.
 *
 * The fold state is also exactly what separates the two ways a delete
 * can leave children behind. Closed, they vanish: `collapsed` still
 * holds the dead parent's id and `ancestorsOf` filters every orphan off
 * the list, present in the plan and reachable only by `zR`. Open, they
 * are simply drawn at the root, which is what deleting a heading does
 * anywhere else and is one `u` away. So the group case is the one this
 * takes, and only that one.
 *
 * **Closed means `collapsed`, and nothing else.** A filter hides rows
 * without claiming they are folded, so it does not make a summary a
 * group — a block that grew because of a query typed earlier would be
 * `yy` meaning two things. Under a closed fold the subtree comes from
 * the *plan*, so it is whole regardless of what else the view is
 * hiding, and the count in the status line is the notice: `delete 5`
 * on one selected row.
 *
 * **Edges inside the block travel with it, edges leaving it do not.**
 * Same rule the nesting already followed: a row whose parent came along
 * is re-parented onto that parent's copy, and one whose parent stayed
 * behind lands at the paste level. An edge is the same question asked of
 * two endpoints, so a copied phase keeps its internal ordering and
 * points at nothing outside itself.
 *
 * **The block is a snapshot.** Every field a put writes comes from the
 * register rather than from the live task, so the edges do too. A dep
 * drawn after the yank is not in the copy, exactly as a title typed
 * after the yank is not.
 */

import { effectiveParent, treeOrder } from "./filter";
import type { Dep, Task, TaskId } from "./types";

/** A yanked block of rows: the tasks, and the edges between them. */
export interface RowBlock {
  /** Tree order — every task ahead of its own descendants. */
  tasks: Task[];
  /** Only edges with both endpoints in `tasks`. */
  deps: Dep[];
}

export const EMPTY_ROWS: RowBlock = { tasks: [], deps: [] };

/**
 * The block a row gesture names: `roots`, the subtree under any of them
 * that `closed` says is folded shut, and the edges among the result.
 *
 * `tasks` is the whole plan, so a subtree that comes at all comes
 * whole; `closed` is `collapsed`, the one thing that makes a summary a
 * group. A closed fold inside a closed fold changes nothing — the outer
 * one already took everything under it, which is what a fold being one
 * row to an operator means.
 *
 * `roots` may overlap — a visual selection routinely holds a parent and
 * its child — so the closure dedupes, and the result is ordered by the
 * plan's own tree walk rather than by the selection. That is what a put
 * needs: it creates rows one at a time and re-parents each onto the
 * copy of its parent, which has to exist by then.
 */
export function rowBlock(
  tasks: Task[],
  deps: Dep[],
  roots: Task[],
  closed: Set<TaskId>,
): RowBlock {
  const ids = new Set(tasks.map((task) => task.id));
  const children = new Map<TaskId, Task[]>();
  for (const task of tasks) {
    const parent = effectiveParent(task, ids);
    if (!parent) continue;
    const bucket = children.get(parent);
    if (bucket) bucket.push(task);
    else children.set(parent, [task]);
  }

  const wanted = new Set<TaskId>();
  // `wanted` is also the loop guard: a parent cycle that survived a
  // merge is a state to walk out of, not one to hang on.
  const descend = (task: Task): void => {
    for (const child of children.get(task.id) ?? []) {
      if (wanted.has(child.id)) continue;
      wanted.add(child.id);
      descend(child);
    }
  };
  for (const root of roots) {
    wanted.add(root.id);
    // The row alone when its fold is open: its children are on screen,
    // so they are rows the gesture did not point at.
    if (closed.has(root.id)) descend(root);
  }

  return {
    tasks: treeOrder(tasks).filter((task) => wanted.has(task.id)),
    deps: deps.filter((dep) => wanted.has(dep.from) && wanted.has(dep.to)),
  };
}

/**
 * The edges to draw between the copies a put has just created.
 *
 * `copies` is yanked id → new id, filled as the rows land. An endpoint
 * missing from it is a row that failed to create, so its edge is
 * dropped rather than pointed at the original — an edge into the block
 * it was copied from is not what the shape said.
 *
 * `lag_days` rides along in the spread: a copied edge that silently
 * became the default spacing would move the copy's dates.
 */
export function copiedDeps(block: RowBlock, copies: Map<TaskId, TaskId>): Dep[] {
  const out: Dep[] = [];
  for (const dep of block.deps) {
    const from = copies.get(dep.from);
    const to = copies.get(dep.to);
    if (from && to) out.push({ ...dep, from, to });
  }
  return out;
}
