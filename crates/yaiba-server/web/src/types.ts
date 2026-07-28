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
}

/** Server-computed placement for one task. */
export interface Scheduled {
  id: TaskId;
  start: string;
  end: string;
  slack_days: number;
  critical: boolean;
  blocked: boolean;
  overdue: boolean;
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
