import { api } from "./api";
import type { AppData, Dep, NewTask, Task, TaskPatch } from "./types";

/**
 * A single reversible edit.
 *
 * Undo replays inverse ops rather than restoring a whole snapshot: with
 * peers merging in the background, stamping an old snapshot back over
 * the store would silently revert *their* edits too. An inverse op is
 * just another write, so it merges like any other.
 */
export type Op =
  | { kind: "create"; task: NewTask }
  /** Re-create a task under its original id, edges included. */
  | { kind: "restore"; task: Task; deps: Dep[] }
  | { kind: "delete"; id: string }
  | { kind: "patch"; id: string; patch: TaskPatch }
  | { kind: "addDep"; dep: Dep }
  | { kind: "removeDep"; dep: Dep }
  | { kind: "reorder"; ids: string[] };

/** One entry on the undo stack: what to replay, and what to reverse it. */
export interface Step {
  redo: Op[];
  undo: Op[];
  /** Shown on the status line when the step is undone or redone. */
  label: string;
}

async function exec(op: Op): Promise<AppData> {
  switch (op.kind) {
    case "create":
      return api.createTask(op.task);
    case "restore": {
      let state = await api.putTask(op.task.id, op.task);
      for (const dep of op.deps) {
        // The edges were valid before the delete, but a peer may have
        // removed one of the endpoints since; a failed edge shouldn't
        // abort the restore of the task itself.
        try {
          state = await api.addDep(dep);
        } catch {
          /* endpoint is gone — skip the edge */
        }
      }
      return state;
    }
    case "delete":
      return api.deleteTask(op.id);
    case "patch":
      return api.patchTask(op.id, op.patch);
    case "addDep":
      return api.addDep(op.dep);
    case "removeDep":
      return api.removeDep(op.dep);
    case "reorder":
      return api.reorder(op.ids);
  }
}

/** Run ops in order and return the final state. */
export async function applyOps(ops: Op[]): Promise<AppData> {
  let state: AppData | null = null;
  for (const op of ops) state = await exec(op);
  return state ?? (await api.getState());
}

/** The fields an inverse patch has to carry to fully restore a task. */
export function snapshotPatch(task: Task): Required<TaskPatch> {
  return {
    parent: task.parent,
    title: task.title,
    notes: task.notes,
    status: task.status,
    priority: task.priority,
    start: task.start,
    duration_days: task.duration_days,
    due: task.due,
    progress: task.progress,
    tags: [...task.tags],
  };
}

/** Restrict a full snapshot to the keys a forward patch touched. */
export function inversePatch(task: Task, forward: TaskPatch): TaskPatch {
  const full = snapshotPatch(task);
  const inverse: TaskPatch = {};
  for (const key of Object.keys(forward) as (keyof TaskPatch)[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (inverse as any)[key] = full[key];
  }
  return inverse;
}
