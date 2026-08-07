import { diffDays, parseDateExpr } from "./dates";
import { t } from "./i18n";
import type { Lang } from "./lang";
import { THEMES, type Theme } from "./theme";
import { SORT_KEYS, type SortKey } from "./filter";
import { inversePatch, type Op } from "./ops";
import {
  DEFAULT_LAG,
  MAX_LAG_DAYS,
  type AppData,
  type Scheduled,
  type Task,
  type TaskPatch,
} from "./types";

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
  /** The list's percent of the split view — `:split 40` and the grip. */
  listWidth?: number;
  /** Show only this subtree; null clears the focus. */
  focus?: string | null;
  /** Hide anything deeper than this; null shows every level. */
  foldLevel?: number | null;
  /** Reference date; null means now. */
  asof?: string | null;
  /**
   * The look, on one axis: neon, office, super.
   *
   * Two sentinels rather than one, because there are three values and
   * two switches on them. `"toggle"` is office ⇄ neon — bare `:theme`
   * and `gt` — and it leaves super the way it leaves neon, since office
   * mode is somewhere you go *to*. `"super-toggle"` is super ⇄ neon,
   * which is `:super` and `gs`.
   */
  theme?: Theme | "toggle" | "super-toggle";
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
 * Every name already assigned to something.
 *
 * There is no user table, so the people who exist are exactly the people
 * somebody has already been given work — the same shape as tags. Which
 * makes completion the only thing keeping a roster consistent: typed
 * from scratch each time, `Yuki` and `yuki` become two names in a report
 * that nobody notices are one person.
 */
export function assigneeNames(ctx: ArgContext): string[] {
  const seen = new Map<string, string>();
  for (const task of ctx.data.tasks) {
    const name = task.assignee.trim();
    // A name with a space in it can only have arrived through the API,
    // since `:assign` refuses one. Completing it would hand back a line
    // that command then rejects, and as a `:f` term it would silently
    // split into two — so it is left out rather than offered broken.
    if (!name || /\s/.test(name)) continue;
    // The first spelling wins, so the list doesn't churn as rows change.
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
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
  "late",
  "unassigned",
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
    args: (ctx) => [
      ...FILTER_WORDS,
      ...tagNames(ctx).map((t) => `tag:${t}`),
      ...assigneeNames(ctx).map((n) => `@${n}`),
    ],
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
  { name: "title" },
  {
    name: "assign",
    aliases: ["owner"],
    // Only the people already on something; a new name is typed in
    // full, which is exactly the moment to see whether it is new.
    args: first(assigneeNames),
  },
  { name: "dep", aliases: ["link"] },
  { name: "undep", aliases: ["unlink"] },
  { name: "theme", args: first(() => THEMES) },
  { name: "office" },
  { name: "super", args: first(() => ["on", "off"]) },
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
  return t("“{title}” is a summary — its {field} comes from its children", { title: task.title, field });
}

/**
 * The earliest date a start pin for `to` can actually hold: the latest
 * finish among its predecessors, or null when nothing constrains it.
 *
 * Summary predecessors are exact here, not an approximation. The server
 * expands an edge out of a summary into one edge per leaf, all carrying
 * the original lag, and the forward pass takes the max — which is the
 * bracket's own end plus that lag, the number this reads.
 */
export function earliestStart(
  deps: AppData["deps"],
  scheduled: Scheduled[],
  to: string,
): string | null {
  let floor: string | null = null;
  for (const dep of deps) {
    if (dep.to !== to) continue;
    const pred = scheduled.find((s) => s.id === dep.from);
    if (pred && (!floor || pred.end > floor)) floor = pred.end;
  }
  return floor;
}

/** What pinning a start takes, beyond the patch itself. */
export interface PinStart {
  ops: Op[];
  undoOps: Op[];
  /** The lag adjustments the pin needed, for the status line. */
  note: string | null;
}

/**
 * Ops that pin `task`'s start at `date` — and make the pin stick.
 *
 * A pinned start is a floor to the scheduler, not a position: the
 * forward pass takes `max(pin, pred_end + lag)`, so a pin dropped
 * inside an edge's lag was silently raised to the day the edge asked
 * for — #81's "the date I typed is visibly ignored", through every
 * gesture that pins. Dropping inside the lag is unambiguous, though:
 * there is no other reason to put it there, so the pin adjusts each
 * crossed edge's lag to the spacing the date implies. Every edge that
 * still crosses after that would keep the floor above the pin, which is
 * why it is every crossed edge and not only the binding one. A pin
 * before a predecessor's finish would invert the edge, and stays
 * refused — with a date, so the retry is one keystroke away.
 *
 * This is the one implementation of that rule. `:start` runs it, and
 * the calendar picker, a cell paste, a bar drag and `.` / `,` all
 * commit through those, so the four gestures cannot drift.
 */
export function pinStartOps(
  data: AppData,
  task: Task,
  date: string,
): PinStart | string {
  const adjust: { before: AppData["deps"][number]; after: AppData["deps"][number]; title: string }[] = [];
  for (const dep of data.deps) {
    if (dep.to !== task.id) continue;
    const pred = data.schedule.tasks.find((s) => s.id === dep.from);
    if (!pred) continue;
    const gap = diffDays(pred.end, date);
    if (gap < 0) {
      const title =
        data.tasks.find((task) => task.id === dep.from)?.title ?? dep.from;
      return t("{d} is before “{title}” finishes ({end})", {
        d: date,
        title,
        end: pred.end,
      });
    }
    if (gap < dep.lag_days) {
      const title =
        data.tasks.find((task) => task.id === dep.from)?.title ?? dep.from;
      adjust.push({ before: dep, after: { ...dep, lag_days: gap }, title });
    }
  }
  const ops: Op[] = [{ kind: "patch", id: task.id, patch: { start: date } }];
  const undoOps: Op[] = [
    { kind: "patch", id: task.id, patch: { start: task.start } },
  ];
  for (const { before, after } of adjust) {
    ops.push({ kind: "addDep", dep: after });
    undoOps.push({ kind: "addDep", dep: before });
  }
  const note =
    adjust.length === 0
      ? null
      : adjust.length === 1
        ? t("lag {a}→{b} on “{title}”", {
            a: adjust[0].before.lag_days,
            b: adjust[0].after.lag_days,
            title: adjust[0].title,
          })
        : t("lag adjusted on {n} links", { n: adjust.length });
  return { ops, undoOps, note };
}

/** Resolve a 1-based row number as typed on the command line. */
function rowAt(ctx: CommandContext, arg: string): Task | string {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > ctx.visible.length) {
    return t("no row {n} (1..{max})", { n: arg, max: ctx.visible.length });
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
  const needTask = (): CommandResult => ({ error: t("no task under the cursor") });

  switch (head) {
    // ---- files & panes ------------------------------------------
    case "w":
    case "write":
      // Every edit is already persisted the moment it is made; `:w` is
      // here because the fingers expect it, and it says so plainly.
      return { message: t("saved on every edit — nothing to flush") };
    case "q":
    case "quit":
      return { ui: { quit: true } };
    case "h":
    case "help":
      return { ui: { help: true } };
    case "list":
    case "gantt":
      return { ui: { view: head as View } };
    // `:split` is the view; `:split 40` is the view *and* where it
    // divides. One word for one thing you are asking for — "show me both,
    // like this" — rather than a second command that only makes sense
    // after the first.
    case "split": {
      if (!arg) return { ui: { view: "split" } };
      const percent = Number(arg.replace(/%$/, ""));
      if (!Number.isFinite(percent)) {
        return { error: t("usage: :split [percent]") };
      }
      return { ui: { view: "split", listWidth: percent } };
    }
    case "view": {
      if (!VIEWS.includes(arg as View)) {
        return { error: t("usage: :view {list}", { list: VIEWS.join("|") }) };
      }
      return { ui: { view: arg as View } };
    }
    case "zoom": {
      if (!ZOOMS.includes(arg as Zoom)) {
        return { error: t("usage: :zoom {list}", { list: ZOOMS.join("|") }) };
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
        return { error: t("usage: :cols {list}  (bare :cols toggles)", { list: COLUMNS.join("|") }) };
      }
      return { ui: { columns: arg as Columns } };
    }

    // ---- listing -------------------------------------------------
    case "f":
    case "filter":
      return {
        ui: { filter: arg },
        message: arg ? t("filter: {q}", { q: arg }) : t("filter cleared"),
      };
    case "sort": {
      if (!SORT_KEYS.includes(arg as SortKey)) {
        return { error: t("usage: :sort {list}", { list: SORT_KEYS.join("|") }) };
      }
      return { ui: { sort: arg as SortKey }, message: t("sorted by {k}", { k: arg }) };
    }

    // ---- tasks ---------------------------------------------------
    case "n":
    case "new": {
      if (!arg) return { error: t("usage: :new <title>") };
      return {
        ops: [{ kind: "create", task: { title: arg, after: current?.id } }],
        label: t("new task"),
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
        label: t("delete {n}", { n: selection.length }),
        message: t("deleted {n}", { n: selection.length }),
      };
    }

    case "due":
    case "start": {
      if (!selection.length) return needTask();
      const clearing = !arg || ["none", "clear", "-"].includes(arg);
      const date = clearing ? null : parseDateExpr(arg, data.today);
      if (!clearing && date === null) return { error: t("bad date: {d}", { d: arg }) };
      // A start pin goes through `pinStartOps` so the date named is the
      // date the bar lands on: an edge whose lag the pin crosses has its
      // lag adjusted in the same commit, and a pin before a predecessor's
      // finish is refused rather than silently raised. Everything that
      // pins a start — this command, the calendar, a cell paste, the
      // gantt's drag, `.` / `,` — meets here.
      if (head === "start" && date) {
        const ops: Op[] = [];
        const undo: Op[] = [];
        const notes: string[] = [];
        for (const task of selection) {
          const refusal = refuseSummary(data, task, t("start date"));
          if (refusal) return { error: refusal };
          const pin = pinStartOps(data, task, date);
          if (typeof pin === "string") return { error: pin };
          ops.push(...pin.ops);
          undo.push(...pin.undoOps);
          if (pin.note) notes.push(pin.note);
        }
        const label = `start ${date}`;
        return {
          ops,
          undoOps: undo,
          label,
          message: [
            selection.length > 1 ? `${label} · ${selection.length}` : label,
            ...notes,
          ].join(" · "),
        };
      }
      return patchSelection(
        selection,
        (task) => {
          // `:due` stays legal on a summary: a deadline for a whole
          // project is a real thing to record, and `overdue` compares
          // it against the rolled-up finish. Only the planned *start*
          // is derived from the children.
          if (head === "start") {
            const refusal = refuseSummary(data, task, t("start date"));
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
          error: t("no end date is stored — set the span with :dur, or move it with :start none"),
        };
      }
      const date = parseDateExpr(arg, data.today);
      if (date === null) return { error: t("bad date: {d}", { d: arg }) };
      return patchSelection(
        selection,
        (task) => {
          const refusal = refuseSummary(data, task, t("dates"));
          if (refusal) return refusal;
          // A task with no `start` of its own is placed by the
          // scheduler. Pin it where it currently sits — the same thing
          // dragging its bar does — so the duration is measured from a
          // date that survives the next recompute.
          const start = task.start ?? scheduled(data, task)?.start;
          if (!start) return t("“{title}” has no start to measure from", { title: task.title });
          const days = diffDays(start, date) + 1;
          if (days < 1) return t("{d} is before the start ({start})", { d: date, start });
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
      if (!clearing && date === null) return { error: t("bad date: {d}", { d: arg }) };
      return patchSelection(
        selection,
        (task) => {
          // Refuse a span that runs backwards. Left in, it would read
          // as a task that finished before it started and quietly skew
          // every plan-vs-actual comparison drawn from it.
          if (date && head === "astart" && task.actual_end) {
            if (diffDays(date, task.actual_end) < 0) {
              return t("{d} is after work finished ({end})", { d: date, end: task.actual_end });
            }
          }
          if (date && head === "aend" && task.actual_start) {
            if (diffDays(task.actual_start, date) < 0) {
              return t("{d} is before work started ({start})", { d: date, start: task.actual_start });
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
        return { error: t("usage: :dur <days ≥ 1>") };
      }
      return patchSelection(
        selection,
        (task) =>
          refuseSummary(data, task, t("span")) ?? {
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
        return { error: t("usage: :prio 0|1|2|3") };
      }
      return patchSelection(selection, () => ({ priority: n }), `prio ${n}`);
    }
    case "pr":
    case "progress": {
      if (!selection.length) return needTask();
      const n = Number(arg.replace(/%$/, ""));
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return { error: t("usage: :progress 0..100") };
      }
      const value = Math.round(n);
      return patchSelection(
        selection,
        (task) =>
          refuseSummary(data, task, t("progress")) ?? {
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
      if (!arg) return { error: t("usage: :tag +dev -ui") };
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
      return patchSelection([current], () => ({ notes: arg }), t("notes"));
    }
    // The title was the one field with no command behind it — `cc` edits
    // it in place, which is the right way to type one and no way at all
    // to *write* one from somewhere else. That was fine until a yanked
    // block could carry a title column, because every put in this app
    // goes through the line the keyboard would have typed and there was
    // no line to run (#87).
    //
    // The whole selection, like `:assign`: renaming a block to one thing
    // is a real edit — three placeholder rows becoming three copies of a
    // heading — and a field command that took only the cursor row for no
    // reason would be the odd one out.
    case "title": {
      if (!selection.length) return needTask();
      // No `none`, unlike the dates and the owner. A row with no title
      // is one you cannot find again; `finishEdit` already refuses to
      // leave one behind and this would be the second way in.
      const title = arg.trim();
      if (!title) return { error: t("usage: :title ⟨text⟩") };
      return patchSelection(selection, () => ({ title }), t("title"));
    }
    case "assign":
    case "owner": {
      // The whole selection, unlike `:notes`: handing a block of rows to
      // one person is the ordinary way this gets used, where a note is
      // prose about one task.
      if (!selection.length) return needTask();
      // Bare clears, and so do the words the date commands already
      // train — `:due none` and `:assign none` should not be two things
      // to remember. Somebody actually called "none" is a stretch worth
      // trading for one grammar.
      const clearing = !arg || ["none", "clear", "-"].includes(arg);
      // The server strips the sigil as well; doing it here too is what
      // makes the message read back as the name that was meant.
      const name = clearing ? "" : arg.replace(/^@/, "").trim();
      if (!clearing && !name) {
        return { error: t("usage: :assign ⟨name⟩  (bare clears)") };
      }
      // One word, the way a tag is. The filter grammar is
      // space-separated, so `Mary Jane` would be stored fine and then be
      // unfindable: `:f @Mary Jane` reads as `@mary` AND `jane`, which
      // misses the row it names and quietly matches every other row with
      // "jane" in it. Refusing at the one place names are created keeps
      // assignment, completion, filtering and the column all agreeing on
      // what a name is, instead of teaching four of them to quote.
      if (/\s/.test(name)) {
        return { error: t("one word per name — try {joined}", {
          joined: name.replace(/\s+/g, "-"),
        }) };
      }
      return patchSelection(
        selection,
        () => ({ assignee: name }),
        name ? `@${name}` : t("unassigned"),
      );
    }

    // ---- dependencies -------------------------------------------
    case "dep":
    case "link": {
      if (!current) return needTask();
      // `:dep 3` and `:dep 3 +0` — the row, then how long after it this
      // one may start. Written with a sign because that is how every
      // other offset here reads (`:due +3d`), and because a bare second
      // number beside a row number invites being read as another row.
      const [row, lagArg, ...extra] = arg.split(/\s+/).filter(Boolean);
      if (extra.length) return { error: t("usage: :dep ⟨row⟩ [+days]") };
      const target = rowAt(ctx, row ?? "");
      if (typeof target === "string") return { error: target };
      if (target.id === current.id) return { error: t("a task can't block itself") };

      let lag_days = DEFAULT_LAG;
      if (lagArg !== undefined) {
        // A negative lag gets its own message: it is a thing people will
        // try, and "bad syntax" would not say why it cannot work.
        if (/^-\d+d?$/.test(lagArg)) {
          return {
            error: t("a dependency cannot overlap — the earliest is +0"),
          };
        }
        // `+0`, `0` and `+2d` all read the same; `:dur` already takes a
        // trailing `d`, so fingers arrive with it.
        if (!/^\+?\d+d?$/.test(lagArg)) {
          return { error: t("usage: :dep ⟨row⟩ [+days]") };
        }
        lag_days = Number(lagArg.replace(/^\+/, "").replace(/d$/, ""));
        // Bounded, and refused rather than silently clamped so the number
        // you typed is the number you get. The store saturates too, but
        // that is a backstop against a peer rather than a place to teach
        // anybody anything: past this, `pred_end + lag` runs off the end
        // of the calendar and the date arithmetic panics — and the
        // scheduler runs on every read, so it would take the project's
        // readability with it.
        if (lag_days > MAX_LAG_DAYS) {
          return { error: t("a lag of more than {n} days is not a plan", { n: MAX_LAG_DAYS }) };
        }
      }

      // `:dep 3` reads as "this one depends on row 3", so row 3 is the
      // predecessor.
      const dep = { from: target.id, to: current.id, lag_days };
      // Re-running `:dep` on an edge that exists is how its lag changes,
      // so undo has to put back the lag that was there rather than the
      // default — which would read as an unrelated edit.
      const before = data.deps.find(
        (d) => d.from === dep.from && d.to === dep.to,
      );
      return {
        ops: [{ kind: "addDep", dep }],
        undoOps: [
          before ? { kind: "addDep", dep: before } : { kind: "removeDep", dep },
        ],
        label: t("link"),
        message:
          lag_days === DEFAULT_LAG
            ? t("depends on “{title}”", { title: target.title })
            : t("depends on “{title}” · +{n}d", {
                title: target.title,
                n: lag_days,
              }),
      };
    }
    case "undep":
    case "unlink": {
      if (!current) return needTask();
      const target = rowAt(ctx, arg);
      if (typeof target === "string") return { error: target };
      // The edge as it stands, so undo restores its lag rather than
      // silently re-linking at the default.
      const dep = data.deps.find(
        (d) => d.from === target.id && d.to === current.id,
      );
      if (!dep) return { error: t("no such dependency") };
      return {
        ops: [{ kind: "removeDep", dep }],
        undoOps: [{ kind: "addDep", dep }],
        label: t("unlink"),
        message: t("unlinked from “{title}”", { title: target.title }),
      };
    }

    // ---- appearance ------------------------------------------------
    case "theme": {
      // No message: applyUi announces the resulting theme itself, and
      // its say() lands after this one, so anything set here is
      // overwritten before it can be read.
      if (THEMES.includes(arg as Theme)) return { ui: { theme: arg as Theme } };
      if (!arg) return { ui: { theme: "toggle" } };
      return {
        error: t("usage: :theme dark|light|super  (bare :theme toggles office)"),
      };
    }
    case "office":
      return { ui: { theme: "light" } };
    // Bare `:super` toggles, unlike `:office`, which only ever goes one
    // way. Office mode is where you go to be readable and `gt` is how
    // you come back; super is a thing you turn on and off, and `:super`
    // is the whole of that switch. `on` / `off` say it outright for
    // anyone who would rather not think about which state they are in.
    case "super": {
      if (arg === "on") return { ui: { theme: "super" } };
      if (arg === "off") return { ui: { theme: "dark" } };
      if (!arg) return { ui: { theme: "super-toggle" } };
      return { error: t("usage: :super on|off  (bare :super toggles)") };
    }
    case "lang": {
      // Same as `:theme`: applyUi says what the setting became, in the
      // language it became.
      if (arg === "en" || arg === "ja") return { ui: { lang: arg } };
      if (!arg) return { ui: { lang: "toggle" } };
      return { error: t("usage: :lang en|ja  (bare :lang toggles)") };
    }

    // ---- the reference date ---------------------------------------
    case "asof":
    case "as": {
      if (!arg || ["today", "now", "none", "-"].includes(arg)) {
        return { ui: { asof: null }, message: t("reference date: today") };
      }
      const date = parseDateExpr(arg, data.today);
      if (!date) return { error: t("bad date: {d}", { d: arg }) };
      return { ui: { asof: date }, message: t("as of {d}", { d: date }) };
    }

    // ---- the work breakdown ---------------------------------------
    case "only":
      if (!current) return { error: t("no task under the cursor") };
      return {
        ui: { focus: current.id, foldLevel: null },
        message: t("focused “{title}” — :all to come back", { title: current.title }),
      };
    case "all":
      return { ui: { focus: null, foldLevel: null }, message: t("showing everything") };
    case "level":
    case "lv": {
      if (!arg) return { ui: { foldLevel: null }, message: t("all levels") };
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 0) {
        return { error: t("usage: :level <0 or more>  (:level with no argument shows all)") };
      }
      return { ui: { foldLevel: n }, message: t("level {n}", { n }) };
    }
    case "parent": {
      if (!current) return { error: t("no task under the cursor") };
      if (!arg || arg === "none" || arg === "-") {
        return {
          ops: [{ kind: "patch", id: current.id, patch: { parent: null } }],
          undoOps: [
            { kind: "patch", id: current.id, patch: { parent: current.parent } },
          ],
          label: t("unparent"),
          message: t("moved to the top level"),
        };
      }
      const target = rowAt(ctx, arg);
      if (typeof target === "string") return { error: target };
      if (target.id === current.id) return { error: t("a task can't contain itself") };
      return {
        ops: [{ kind: "patch", id: current.id, patch: { parent: target.id } }],
        undoOps: [
          { kind: "patch", id: current.id, patch: { parent: current.parent } },
        ],
        label: t("reparent"),
        message: t("moved under “{title}”", { title: target.title }),
      };
    }

    // ---- peers ---------------------------------------------------
    case "ticket":
    case "share":
      return { peer: { showTicket: true } };
    case "join": {
      if (!arg) return { error: t("usage: :join <ticket>") };
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
              ? t(
                  "usage: :proj rename ⟨new name⟩ — renames the project you are on",
                )
              : t("usage: :proj {verb} ⟨name⟩", { verb }),
        };
      }
      return { project: { switch: arg } };
    }

    default:
      return { error: t("not a command: {name}  (try :help)", { name: head }) };
  }
}
