import { diffDays, parseDateExpr } from "./dates";
import type { Lang } from "./lang";
import type { Theme } from "./theme";
import { SORT_KEYS, type SortKey } from "./filter";
import { inversePatch, type Op } from "./ops";
import type { AppData, Scheduled, Task, TaskPatch } from "./types";

export type View = "list" | "gantt" | "split";
export type Zoom = "day" | "week" | "month";

/**
 * Which columns the list carries on its right-hand side.
 *
 * `compact` is the working view — a title and the few markers that say
 * whether a row needs attention. `dates` trades that quiet for the four
 * columns a progress meeting asks for: what was planned, and what
 * happened.
 */
export type Columns = "compact" | "dates";

/**
 * The date columns, named for the command that edits each one.
 *
 * The name is the contract: a click on a cell commits by handing
 * `runCommand` the line the keyboard would have typed, so every rule
 * lives in one place — a summary's dates come from its children, an
 * actual span cannot run backwards, and the plan's finish is a duration
 * in disguise.
 */
export type DateField = "start" | "end" | "astart" | "aend";

export const VIEWS: View[] = ["list", "gantt", "split"];
export const ZOOMS: Zoom[] = ["day", "week", "month"];
export const COLUMNS: Columns[] = ["compact", "dates"];

export interface UiPatch {
  view?: View;
  /** `"toggle"` flips between the two — what bare `:dates` and `gd` do. */
  columns?: Columns | "toggle";
  /** Show only this subtree; null clears the focus. */
  focus?: string | null;
  /** Hide anything deeper than this; null shows every level. */
  foldLevel?: number | null;
  /** Reference date; null means now. */
  asof?: string | null;
  /** `"toggle"` flips to the other one — what bare `:theme` and `gt` do. */
  theme?: Theme | "toggle";
  /** Weekday names only; `"toggle"` is what bare `:lang` does. */
  lang?: Lang | "toggle";
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
  /**
   * Names of the projects the server holds open.
   *
   * `:proj` needs them to tell a *verb* from a project called `new`,
   * `rename` or `forget` — see the bare-verb handling below.
   */
  projects: string[];
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
  /** Project actions the app performs against /api/projects. */
  project?: {
    switch?: string;
    pick?: boolean;
    create?: string;
    rename?: string;
    forget?: string;
  };
}

// ---- the command table, for <tab> completion ---------------------
//
// This lists the same names the `switch` in `runCommand` dispatches on,
// and nothing enforces that it stays in step: a `case` added below
// without an entry here still runs, it just can't be completed, and an
// entry here without a `case` completes into "not a command". Add both.

export interface ArgContext {
  data: AppData;
  /** Names of the projects the server holds open, for `:proj`. */
  projects: string[];
}

export interface CommandSpec {
  /** What completion inserts — the long form wherever there is one. */
  name: string;
  /**
   * Short forms `runCommand` also accepts. Typing one still finds the
   * spec, but the menu only ever lists `name` — vim offers `:write`,
   * not `:w`, and the abbreviation keeps working regardless.
   */
  aliases?: string[];
  /** Candidates for the `n`-th argument (1-based); none by default. */
  args?: (ctx: ArgContext, n: number) => string[];
}

/** Wrap a candidate list that only applies to the first argument. */
function first(build: (ctx: ArgContext) => string[]) {
  return (ctx: ArgContext, n: number) => (n === 1 ? build(ctx) : []);
}

/** Every tag in use, which is the only tag vocabulary there is. */
function tagNames(ctx: ArgContext): string[] {
  return [...new Set(ctx.data.tasks.flatMap((t) => t.tags))].sort();
}

/**
 * The words `parseDateExpr` understands, minus the open-ended ones —
 * `+3d` stands in for the whole relative family, and no completion can
 * guess a calendar date for you.
 */
const DATE_WORDS = [
  "today",
  "tomorrow",
  "yesterday",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
  "+1d",
  "+1w",
  "+1m",
  "none",
];

/** The fixed half of the filter grammar in `filter.ts`. */
const FILTER_WORDS = [
  "open",
  "done",
  "doing",
  "crit",
  "blocked",
  "overdue",
  "status:todo",
  "status:doing",
  "status:done",
];

export const COMMANDS: CommandSpec[] = [
  { name: "write", aliases: ["w"] },
  { name: "quit", aliases: ["q"] },
  { name: "help", aliases: ["h"] },
  { name: "list" },
  { name: "gantt" },
  { name: "split" },
  { name: "view", args: first(() => VIEWS) },
  { name: "zoom", args: first(() => ZOOMS) },
  { name: "dates" },
  { name: "columns", aliases: ["cols"], args: first(() => COLUMNS) },
  {
    name: "filter",
    aliases: ["f"],
    // Every term ANDs with the last, so this one completes at any depth.
    args: (ctx) => [...FILTER_WORDS, ...tagNames(ctx).map((t) => `tag:${t}`)],
  },
  { name: "sort", args: first(() => SORT_KEYS) },
  { name: "new", aliases: ["n"] },
  { name: "delete", aliases: ["d"] },
  { name: "due", args: first(() => DATE_WORDS) },
  { name: "start", args: first(() => DATE_WORDS) },
  { name: "end", args: first(() => DATE_WORDS) },
  { name: "duration", aliases: ["dur"] },
  { name: "astart", args: first(() => DATE_WORDS) },
  { name: "aend", args: first(() => DATE_WORDS) },
  { name: "priority", aliases: ["prio"], args: first(() => ["0", "1", "2", "3"]) },
  { name: "progress", aliases: ["pr"] },
  {
    name: "tag",
    // `+dev` and `-dev` both, so the sign you have already typed narrows
    // the list to the half that can follow it.
    args: (ctx) => tagNames(ctx).flatMap((t) => [`+${t}`, `-${t}`]),
    aliases: ["t"],
  },
  { name: "notes", aliases: ["note"] },
  { name: "dep", aliases: ["link"] },
  { name: "undep", aliases: ["unlink"] },
  { name: "theme", args: first(() => ["dark", "light"]) },
  { name: "office" },
  { name: "lang", args: first(() => ["en", "ja"]) },
  { name: "asof", aliases: ["as"], args: first(() => DATE_WORDS) },
  { name: "only" },
  { name: "all" },
  { name: "level", aliases: ["lv"] },
  { name: "parent" },
  { name: "ticket", aliases: ["share"] },
  { name: "join" },
  { name: "proj", aliases: ["project"], args: first((ctx) => ctx.projects) },
];

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

/** The server's placement for a task, which is what the gantt draws. */
function scheduled(data: AppData, task: Task): Scheduled | undefined {
  return data.schedule.tasks.find((s) => s.id === task.id);
}

/**
 * Refuse an edit to a field the scheduler derives for summaries.
 *
 * A summary's dates span its children and its progress is their
 * weighted roll-up, so a value typed here is not wrong so much as
 * *ignored* — the next recompute overwrites it. Silently accepting the
 * patch is the worse failure: the row reports a start date the gantt
 * never draws. Returns the refusal for `patchSelection`, or null when
 * the task is an ordinary leaf.
 */
function refuseSummary(data: AppData, task: Task, field: string): string | null {
  if (!scheduled(data, task)?.summary) return null;
  return `“${task.title}” is a summary — its ${field} comes from its children`;
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
      if (!VIEWS.includes(arg as View)) {
        return { error: `usage: :view ${VIEWS.join("|")}` };
      }
      return { ui: { view: arg as View } };
    }
    case "zoom": {
      if (!ZOOMS.includes(arg as Zoom)) {
        return { error: `usage: :zoom ${ZOOMS.join("|")}` };
      }
      return { ui: { zoom: arg as Zoom } };
    }
    // No message on either of these: `applyUi` announces the columns it
    // ended up on, and its `say()` lands after this one would.
    case "dates":
      return { ui: { columns: "toggle" } };
    case "cols":
    case "columns": {
      if (!arg) return { ui: { columns: "toggle" } };
      if (!COLUMNS.includes(arg as Columns)) {
        return { error: `usage: :cols ${COLUMNS.join("|")}  (bare :cols toggles)` };
      }
      return { ui: { columns: arg as Columns } };
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
        (task) => {
          // `:due` stays legal on a summary: a deadline for a whole
          // project is a real thing to record, and `overdue` compares
          // it against the rolled-up finish. Only the planned *start*
          // is derived from the children.
          if (head === "start") {
            const refusal = refuseSummary(data, task, "start date");
            if (refusal) return refusal;
          }
          return head === "due" ? { due: date } : { start: date };
        },
        `${head} ${date ?? "cleared"}`,
      );
    }

    // The plan's finish is not a stored field — it is `start` +
    // `duration_days`. Keeping an end date as well would leave three
    // values free to disagree the next time a dependency pushes the
    // task sideways, so `:end` is sugar over `:dur`: say where it
    // lands and the duration follows.
    case "end": {
      if (!selection.length) return needTask();
      // Every other date command clears on `none`, so the word arrives
      // here already trained — and `parseDateExpr` maps it to null,
      // which would come back as `bad date: none` and read as a parse
      // failure. There is no end field to clear; say what to reach for
      // instead.
      if (!arg || ["none", "clear", "-"].includes(arg)) {
        return {
          error: "no end date is stored — set the span with :dur, or move it with :start none",
        };
      }
      const date = parseDateExpr(arg, data.today);
      if (date === null) return { error: `bad date: ${arg}` };
      return patchSelection(
        selection,
        (task) => {
          const refusal = refuseSummary(data, task, "dates");
          if (refusal) return refusal;
          // A task with no `start` of its own is placed by the
          // scheduler. Pin it where it currently sits — the same thing
          // dragging its bar does — so the duration is measured from a
          // date that survives the next recompute.
          const start = task.start ?? scheduled(data, task)?.start;
          if (!start) return `“${task.title}” has no start to measure from`;
          const days = diffDays(start, date) + 1;
          if (days < 1) return `${date} is before the start (${start})`;
          return { start, duration_days: days };
        },
        `end ${date}`,
      );
    }

    // The actuals the server stamps as work happens, typed by hand when
    // you are recording after the fact. Both ends are stored here,
    // unlike the plan: an actual span is a record of what happened, not
    // something the scheduler is free to move.
    case "astart":
    case "aend": {
      if (!selection.length) return needTask();
      const clearing = !arg || ["none", "clear", "-"].includes(arg);
      const date = clearing ? null : parseDateExpr(arg, data.today);
      if (!clearing && date === null) return { error: `bad date: ${arg}` };
      return patchSelection(
        selection,
        (task) => {
          // Refuse a span that runs backwards. Left in, it would read
          // as a task that finished before it started and quietly skew
          // every plan-vs-actual comparison drawn from it.
          if (date && head === "astart" && task.actual_end) {
            if (diffDays(date, task.actual_end) < 0) {
              return `${date} is after work finished (${task.actual_end})`;
            }
          }
          if (date && head === "aend" && task.actual_start) {
            if (diffDays(task.actual_start, date) < 0) {
              return `${date} is before work started (${task.actual_start})`;
            }
          }
          return head === "astart"
            ? { actual_start: date }
            : { actual_end: date };
        },
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
        (task) =>
          refuseSummary(data, task, "span") ?? {
            duration_days: Math.round(days),
          },
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
        (task) =>
          refuseSummary(data, task, "progress") ?? {
            progress: value,
            // 100% and "still todo" is a state nobody means to be in.
            ...(value === 100 ? { status: "done" as const } : {}),
          },
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

    // ---- appearance ------------------------------------------------
    case "theme": {
      // No message: applyUi announces the resulting theme itself, and
      // its say() lands after this one, so anything set here is
      // overwritten before it can be read.
      if (arg === "dark" || arg === "light") return { ui: { theme: arg } };
      if (!arg) return { ui: { theme: "toggle" } };
      return { error: "usage: :theme dark|light  (bare :theme toggles)" };
    }
    case "office":
      return { ui: { theme: "light" } };
    case "lang": {
      // Same as `:theme`: applyUi says what the setting became, in the
      // language it became.
      if (arg === "en" || arg === "ja") return { ui: { lang: arg } };
      if (!arg) return { ui: { lang: "toggle" } };
      return { error: "usage: :lang en|ja  (bare :lang toggles)" };
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

    // ---- projects ------------------------------------------------
    case "proj":
    case "project": {
      // No argument opens the picker, which is the usual way in: the
      // list is short and filtering it beats recalling a name exactly.
      if (!arg) return { project: { pick: true } };
      const [verb, ...rest] = arg.split(/\s+/);
      const subject = rest.join(" ").trim();
      const isVerb = ["new", "forget", "rename"].includes(verb);
      if (isVerb && subject) {
        if (verb === "new") return { project: { create: subject } };
        if (verb === "forget") return { project: { forget: subject } };
        return { project: { rename: subject } };
      }
      // A bare verb is a *switch* when a project by that name is open, so
      // one genuinely called `new` stays reachable — and a usage error
      // when none is, which is the far likelier reading of `:proj rename`
      // with nothing after it. Deciding it by what exists beats picking
      // one meaning for all three: reachability and a good message were
      // only in tension while this guessed.
      if (isVerb && !ctx.projects.includes(verb)) {
        return {
          error:
            verb === "rename"
              ? "usage: :proj rename ⟨new name⟩ — renames the project you are on"
              : `usage: :proj ${verb} ⟨name⟩`,
        };
      }
      return { project: { switch: arg } };
    }

    default:
      return { error: `not a command: ${head}  (try :help)` };
  }
}
