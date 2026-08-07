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
