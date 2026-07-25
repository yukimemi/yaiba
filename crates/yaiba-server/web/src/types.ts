/** Task ids are UUIDs — every peer mints its own without coordinating. */
export type TaskId = string;

export type Status = "todo" | "doing" | "done";

export interface Task {
  id: TaskId;
  title: string;
  notes: string;
  status: Status;
  /** 0 none, 1 low, 2 mid, 3 high. */
  priority: number;
  /** ISO date, or null to let the scheduler place it. */
  start: string | null;
  duration_days: number;
  due: string | null;
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
  depth: number;
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
  today: string;
  /** This replica's id. */
  node_id: string;
}

export interface NewTask {
  title: string;
  notes?: string;
  status?: Status;
  priority?: number;
  start?: string | null;
  duration_days?: number;
  due?: string | null;
  progress?: number;
  tags?: string[];
  after?: TaskId | null;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "notes"
    | "status"
    | "priority"
    | "start"
    | "duration_days"
    | "due"
    | "progress"
    | "tags"
  >
>;
