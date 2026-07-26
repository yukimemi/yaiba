import { parseDateExpr } from "./dates";
import { SORT_KEYS, type SortKey } from "./filter";
import { inversePatch, type Op } from "./ops";
import type { AppData, Task, TaskPatch } from "./types";

export type View = "list" | "gantt" | "split";
export type Zoom = "day" | "week" | "month";

export interface UiPatch {
  view?: View;
  /** Show only this subtree; null clears the focus. */
  focus?: string | null;
  /** Hide anything deeper than this; null shows every level. */
  foldLevel?: number | null;
  /** Reference date; null means now. */
  asof?: string | null;
  zoom?: Zoom;
  filter?: string;
  sort?: SortKey;
  help?: boolean;
  quit?: boolean;
}

export interface CommandContext {
  data: AppData;
  /** Rows currently on screen, in display order — `:dep 3` counts these. */
  visible: Task[];
  /** The task under the cursor, if any. */
  current: Task | null;
  /** Cursor row, or the visual selection when one is active. */
  selection: Task[];
}

export interface CommandResult {
  ops?: Op[];
  /** Inverse of `ops`, pushed onto the undo stack. */
  undoOps?: Op[];
  label?: string;
  message?: string;
  error?: string;
  ui?: UiPatch;
  /** Peer-to-peer actions the app performs against /api/peers. */
  peer?: { join?: string; showTicket?: boolean };
}

/** Apply the same patch to every selected row, with its inverse. */
function patchSelection(
  selection: Task[],
  build: (task: Task) => TaskPatch | string,
  label: string,
): CommandResult {
  const ops: Op[] = [];
  const undo: Op[] = [];
  for (const task of selection) {
    const patch = build(task);
    if (typeof patch === "string") return { error: patch };
    ops.push({ kind: "patch", id: task.id, patch });
    undo.push({ kind: "patch", id: task.id, patch: inversePatch(task, patch) });
  }
  return {
    ops,
    undoOps: undo,
    label,
    message: selection.length > 1 ? `${label} · ${selection.length}` : label,
  };
}

/** Resolve a 1-based row number as typed on the command line. */
function rowAt(ctx: CommandContext, arg: string): Task | string {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > ctx.visible.length) {
    return `no row ${arg} (1..${ctx.visible.length})`;
  }
  return ctx.visible[n - 1];
}

export function runCommand(
  input: string,
  ctx: CommandContext,
): CommandResult | null {
  const line = input.trim();
  if (!line) return null;
  const [head, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ");
  const { current, selection, data } = ctx;
  const needTask = (): CommandResult => ({ error: "no task under the cursor" });

  switch (head) {
    // ---- files & panes ------------------------------------------
    case "w":
    case "write":
      // Every edit is already persisted the moment it is made; `:w` is
      // here because the fingers expect it, and it says so plainly.
      return { message: "saved on every edit — nothing to flush" };
    case "q":
    case "quit":
      return { ui: { quit: true } };
    case "h":
    case "help":
      return { ui: { help: true } };
    case "list":
    case "gantt":
    case "split":
      return { ui: { view: head as View } };
    case "view": {
      if (!["list", "gantt", "split"].includes(arg)) {
        return { error: "usage: :view list|gantt|split" };
      }
      return { ui: { view: arg as View } };
    }
    case "zoom": {
      if (!["day", "week", "month"].includes(arg)) {
        return { error: "usage: :zoom day|week|month" };
      }
      return { ui: { zoom: arg as Zoom } };
    }

    // ---- listing -------------------------------------------------
    case "f":
    case "filter":
      return {
        ui: { filter: arg },
        message: arg ? `filter: ${arg}` : "filter cleared",
      };
    case "sort": {
      if (!SORT_KEYS.includes(arg as SortKey)) {
        return { error: `usage: :sort ${SORT_KEYS.join("|")}` };
      }
      return { ui: { sort: arg as SortKey }, message: `sorted by ${arg}` };
    }

    // ---- tasks ---------------------------------------------------
    case "n":
    case "new": {
      if (!arg) return { error: "usage: :new <title>" };
      return {
        ops: [{ kind: "create", task: { title: arg, after: current?.id } }],
        label: "new task",
        message: arg,
      };
    }
    case "d":
    case "delete": {
      if (!selection.length) return needTask();
      const ops: Op[] = selection.map((t) => ({ kind: "delete", id: t.id }));
      const undo: Op[] = selection.map((t) => ({
        kind: "restore",
        task: t,
        deps: data.deps.filter((d) => d.from === t.id || d.to === t.id),
      }));
      return {
        ops,
        undoOps: undo,
        label: `delete ${selection.length}`,
        message: `deleted ${selection.length}`,
      };
    }

    case "due":
    case "start": {
      if (!selection.length) return needTask();
      const clearing = !arg || ["none", "clear", "-"].includes(arg);
      const date = clearing ? null : parseDateExpr(arg, data.today);
      if (!clearing && date === null) return { error: `bad date: ${arg}` };
      return patchSelection(
        selection,
        () => (head === "due" ? { due: date } : { start: date }),
        `${head} ${date ?? "cleared"}`,
      );
    }
    case "dur":
    case "duration": {
      if (!selection.length) return needTask();
      const days = Number(arg.replace(/d$/, ""));
      if (!Number.isFinite(days) || days < 1) {
        return { error: "usage: :dur <days ≥ 1>" };
      }
      return patchSelection(
        selection,
        () => ({ duration_days: Math.round(days) }),
        `${Math.round(days)}d`,
      );
    }
    case "prio":
    case "priority": {
      if (!selection.length) return needTask();
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 0 || n > 3) {
        return { error: "usage: :prio 0|1|2|3" };
      }
      return patchSelection(selection, () => ({ priority: n }), `prio ${n}`);
    }
    case "pr":
    case "progress": {
      if (!selection.length) return needTask();
      const n = Number(arg.replace(/%$/, ""));
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return { error: "usage: :progress 0..100" };
      }
      const value = Math.round(n);
      return patchSelection(
        selection,
        () => ({
          progress: value,
          // 100% and "still todo" is a state nobody means to be in.
          ...(value === 100 ? { status: "done" as const } : {}),
        }),
        `${value}%`,
      );
    }
    case "t":
    case "tag": {
      if (!selection.length) return needTask();
      if (!arg) return { error: "usage: :tag +dev -ui" };
      const terms = arg.split(/\s+/).filter(Boolean);
      return patchSelection(
        selection,
        (task) => {
          const tags = new Set(task.tags);
          for (const term of terms) {
            const name = term.replace(/^[+-]/, "").replace(/^#/, "");
            if (!name) continue;
            if (term.startsWith("-")) tags.delete(name);
            else tags.add(name);
          }
          return { tags: [...tags].sort() };
        },
        `tag ${arg}`,
      );
    }
    case "note":
    case "notes": {
      if (!current) return needTask();
      return patchSelection([current], () => ({ notes: arg }), "notes");
    }

    // ---- dependencies -------------------------------------------
    case "dep":
    case "link": {
      if (!current) return needTask();
      const target = rowAt(ctx, arg);
      if (typeof target === "string") return { error: target };
      if (target.id === current.id) return { error: "a task can't block itself" };
      // `:dep 3` reads as "this one depends on row 3", so row 3 is the
      // predecessor.
      const dep = { from: target.id, to: current.id };
      return {
        ops: [{ kind: "addDep", dep }],
        undoOps: [{ kind: "removeDep", dep }],
        label: "link",
        message: `depends on “${target.title}”`,
      };
    }
    case "undep":
    case "unlink": {
      if (!current) return needTask();
      const target = rowAt(ctx, arg);
      if (typeof target === "string") return { error: target };
      const dep = { from: target.id, to: current.id };
      if (!data.deps.some((d) => d.from === dep.from && d.to === dep.to)) {
        return { error: "no such dependency" };
      }
      return {
        ops: [{ kind: "removeDep", dep }],
        undoOps: [{ kind: "addDep", dep }],
        label: "unlink",
        message: `unlinked from “${target.title}”`,
      };
    }

    // ---- the reference date ---------------------------------------
    case "asof":
    case "as": {
      if (!arg || ["today", "now", "none", "-"].includes(arg)) {
        return { ui: { asof: null }, message: "reference date: today" };
      }
      const date = parseDateExpr(arg, data.today);
      if (!date) return { error: `bad date: ${arg}` };
      return { ui: { asof: date }, message: `as of ${date}` };
    }

    // ---- the work breakdown ---------------------------------------
    case "only":
      if (!current) return { error: "no task under the cursor" };
      return {
        ui: { focus: current.id, foldLevel: null },
        message: `focused “${current.title}” — :all to come back`,
      };
    case "all":
      return { ui: { focus: null, foldLevel: null }, message: "showing everything" };
    case "level":
    case "lv": {
      if (!arg) return { ui: { foldLevel: null }, message: "all levels" };
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 0) {
        return { error: "usage: :level <0 or more>  (:level with no argument shows all)" };
      }
      return { ui: { foldLevel: n }, message: `level ${n}` };
    }
    case "parent": {
      if (!current) return { error: "no task under the cursor" };
      if (!arg || arg === "none" || arg === "-") {
        return {
          ops: [{ kind: "patch", id: current.id, patch: { parent: null } }],
          undoOps: [
            { kind: "patch", id: current.id, patch: { parent: current.parent } },
          ],
          label: "unparent",
          message: "moved to the top level",
        };
      }
      const target = rowAt(ctx, arg);
      if (typeof target === "string") return { error: target };
      if (target.id === current.id) return { error: "a task can't contain itself" };
      return {
        ops: [{ kind: "patch", id: current.id, patch: { parent: target.id } }],
        undoOps: [
          { kind: "patch", id: current.id, patch: { parent: current.parent } },
        ],
        label: "reparent",
        message: `moved under “${target.title}”`,
      };
    }

    // ---- peers ---------------------------------------------------
    case "ticket":
    case "share":
      return { peer: { showTicket: true } };
    case "join": {
      if (!arg) return { error: "usage: :join <ticket>" };
      return { peer: { join: arg } };
    }

    default:
      return { error: `not a command: ${head}  (try :help)` };
  }
}
