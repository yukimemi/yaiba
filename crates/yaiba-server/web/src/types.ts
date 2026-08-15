/** Task ids are UUIDs — every peer mints its own without coordinating. */
export type TaskId = string;

export type Status = "todo" | "doing" | "done";

export interface Task {
  id: TaskId;
  /**
   * Enclosing task. `null` makes this a root — which is what a
   * "project" is here. Orthogonal to dependencies: a parent *contains*
   * its children, a dependency *orders* two tasks.
   */
  parent: TaskId | null;
  title: string;
  notes: string;
  /**
   * Who the task belongs to; `""` means nobody has taken it. A free-text
   * name — there is no user table, so the server normalises the sigil
   * and the whitespace and leaves the spelling alone.
   */
  assignee: string;
  status: Status;
  /** 0 none, 1 low, 2 mid, 3 high. */
  priority: number;
  /** ISO date, or null to let the scheduler place it. */
  start: string | null;
  duration_days: number;
  due: string | null;
  /** When work actually began; set on the first move off todo. */
  actual_start: string | null;
  /** When work actually finished; set on done, cleared on reopen. */
  actual_end: string | null;
  progress: number;
  position: number;
  tags: string[];
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

/** A finish-to-start edge: `from` must finish before `to` may start. */
export interface Dep {
  from: TaskId;
  to: TaskId;
  /**
   * Calendar days from `from`'s finish to the earliest `to` may start.
   *
   * `1` is "the next day" and is what every edge meant before the field
   * existed, so it is what the server fills in for a body that omits it.
   * `0` lets two linked tasks share a date. Never negative — the store
   * clamps and `:dep` refuses.
   *
   * Required rather than optional on purpose: every place that builds an
   * edge should have to say what spacing it means, and the one gesture
   * with no way to ask — the gantt's drag-to-link — should be visibly
   * choosing the default rather than quietly omitting it.
   */
  lag_days: number;
}

/** What an edge means when nothing has been said about its spacing. */
export const DEFAULT_LAG = 1;

/**
 * The largest lag an edge may carry: a hundred years.
 *
 * Mirrors `MAX_LAG_DAYS` in `yaiba-core`, and is a bound rather than an
 * opinion — past it the scheduler's `pred_end + lag` runs off the end of
 * the calendar, and its date arithmetic panics. `:dep` refuses above this
 * so the number you typed is the number you get; the store clamps as a
 * backstop against a peer that does not.
 */
export const MAX_LAG_DAYS = 36_500;

/** Whether `duration_days` counts calendar days or working days. */
export type CalendarMode = "days" | "workdays";

/**
 * Which built-in holiday table the project uses, if any.
 *
 * A value rather than a Japan-or-not flag: a boolean would bake one
 * country into the protocol, and a second region would then have to
 * break it. Adding one is a variant here and a table on the server —
 * the wire format does not move.
 *
 * A table nobody here has heard of degrades to `none`, which is a
 * version difference showing up as a date difference: while the tables
 * live in the code rather than in the log, an older replica computes a
 * different plan than a newer one that wrote the region. Honest and
 * unavoidable — the alternative is refusing to open the project.
 */
export type HolidaySet = "none" | "jp";

/**
 * The project's working calendar, as the server resolved it.
 *
 * The server answers this question, not the client. Re-implementing a
 * holiday table in TypeScript would be two answers to one question —
 * the same reason `Scheduled` is computed over there — so what arrives
 * is a plain list of dates with the rules already applied.
 *
 * It is sent on every state read, in both modes: `mode` is only the
 * scheduler's business, while `week`, `holidays` and `workdays` say
 * which days are shaded and are true whatever the durations mean.
 */
export interface Calendar {
  mode: CalendarMode;
  /**
   * The work week, **Monday first** — index 0 is Monday.
   *
   * Sent in that order in the JSON too, rather than in `Date.getDay()`
   * order, because a work week is read Mon→Sun everywhere this app is
   * used. `isOffWeekday` in `dates.ts` is the one place the two orders
   * meet.
   */
  week: boolean[];
  /**
   * The built-in holiday table in use, or `"none"`.
   *
   * Reported by `:cal` and sent back by `:cal region`, and read for
   * nothing else — shading comes from `holidays` and `week`, which the
   * server has already resolved. So a region this build has never
   * heard of still draws correctly: the days arrive named, and the word
   * naming the table is only ever echoed.
   */
  region: HolidaySet;
  /**
   * ISO date → holiday name, `""` when the day is off but unnamed.
   *
   * The region's table and the project's own holidays, already merged
   * — which is also the way a country with no built-in table is
   * supported: its days arrive through `CalendarPatch.days`, and land
   * here indistinguishable from a built-in one.
   *
   * Weekends are **not** listed — `week` says what they are, and
   * enumerating them would be a few hundred entries per year of
   * something the client can work out.
   *
   * Resolved over `[today - 1y, today + 3y]` only. The window is what
   * keeps the payload bounded; outside it the client knows the week
   * mask and nothing else, so a holiday five years out is drawn as an
   * ordinary working day until the window catches up with it.
   */
  holidays: Record<string, string>;
  /** Days worked despite the week mask or the holiday table. */
  workdays: string[];
}

/**
 * What the plan looks like before anybody says otherwise: calendar
 * days, a Monday-to-Friday week, no holiday table.
 *
 * Stands in for a `calendar` a reply did not carry — an older replica,
 * or a server mid-upgrade. Degrading to today's behaviour is the whole
 * point of the default: nothing on screen moves.
 */
export const DEFAULT_CALENDAR: Calendar = {
  mode: "days",
  week: [true, true, true, true, true, false, false],
  region: "none",
  holidays: {},
  workdays: [],
};

/**
 * A write to the calendar — `PUT /api/calendar`, patch semantics.
 *
 * Absent keys are left alone, which is what lets `:cal region jp` be
 * one key rather than a whole calendar the client would have to echo
 * back (and would race a peer's edit doing it).
 */
export interface CalendarPatch {
  mode?: CalendarMode;
  /** Monday first, seven entries — the server refuses anything else. */
  week?: boolean[];
  /** `"none"` drops the built-in table; the marked days stay. */
  region?: HolidaySet;
  /**
   * Per-day marks: a name (or bare `true`) makes the day off, `false`
   * makes it worked, and `null` removes the mark. Three values because
   * "off", "on" and "no opinion" are three different things — a cleared
   * day falls back to the week mask, which is not the same as being
   * pinned to either answer.
   *
   * A whole map per request, not a day per request: this is where a
   * project outside the built-in tables loads its own public holidays,
   * and a year of them is one write.
   */
  days?: Record<string, string | boolean | null>;
}

/** Server-computed placement for one task. */
export interface Scheduled {
  id: TaskId;
  start: string;
  end: string;
  slack_days: number;
  critical: boolean;
  blocked: boolean;
  /** The plan overruns a date somebody typed in — never true without a `due`. */
  overdue: boolean;
  /**
   * Still open, and its computed finish is already in the past.
   *
   * The other half of `overdue` and the one most rows are eligible for:
   * measured against the reference date, so it moves with `:asof`, and
   * needing no `due`. A summary carries it when anything inside it does.
   */
  late: boolean;
  /** Depth in the work breakdown: 0 = a root/project. Drives indent and folding. */
  level: number;
  /** Has children, so dates and progress are rolled up rather than entered. */
  summary: boolean;
  /** Own progress for a leaf; the weighted roll-up for a summary. */
  progress: number;
  /** Direct child count — enough to draw a fold marker. */
  children: number;
}

export interface Schedule {
  tasks: Scheduled[];
  start: string;
  end: string;
  critical_path: TaskId[];
}

export interface AppData {
  tasks: Task[];
  deps: Dep[];
  schedule: Schedule;
  /**
   * The working calendar every date on screen is read against.
   *
   * Read from the live project even under `:asof`, the way the server
   * reads it: the CRDT keeps no history for it, so a past calendar
   * would have to be invented, and inventing one is worse than showing
   * today's.
   */
  calendar: Calendar;
  /** The date everything is computed against — the reference date. */
  today: string;
  /** True when `today` is a chosen past date rather than now. */
  as_of: boolean;
  /** This replica's id. */
  node_id: string;
}

export interface NewTask {
  parent?: TaskId | null;
  title: string;
  notes?: string;
  assignee?: string;
  status?: Status;
  priority?: number;
  start?: string | null;
  duration_days?: number;
  due?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
  progress?: number;
  tags?: string[];
  after?: TaskId | null;
  /** Placed above this row instead — what `O` means. Wins over `after`. */
  before?: TaskId | null;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "parent"
    | "title"
    | "notes"
    | "assignee"
    | "status"
    | "priority"
    | "start"
    | "duration_days"
    | "due"
    | "actual_start"
    | "actual_end"
    | "progress"
    | "tags"
  >
>;
