import type { AppData, Dep, NewTask, Task, TaskPatch } from "./types";
import type { ProjectUiState } from "./uiState";

/**
 * Thrown for any non-2xx response. The server puts a human-readable
 * reason in `{ "error": ... }`, which the status line renders verbatim —
 * cycle rejections in particular are worth showing as-is.
 */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path: string, init?: RequestInit): Promise<AppData> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body (proxy timeout, HTML error page) — the
      // status text above is the best we have.
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as AppData;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export interface PeersInfo {
  /** Null when this replica runs with `--no-sync`. */
  ticket: string | null;
  peers: string[];
}

async function peersRequest(
  init?: RequestInit,
  path = "/api/peers",
): Promise<PeersInfo> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as PeersInfo;
}

export interface ProjectInfo {
  name: string;
  db: string;
  /** Null when this replica runs with `--no-sync`. */
  ticket: string | null;
  peers: number;
}

export interface ProjectsInfo {
  projects: ProjectInfo[];
  active: string;
}

async function projectsRequest(
  init?: RequestInit,
  path = "/api/projects",
): Promise<ProjectsInfo> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as ProjectsInfo;
}

async function uiRequest(init?: RequestInit): Promise<ProjectUiState> {
  const res = await fetch("/api/ui", {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as ProjectUiState;
}

/**
 * What a push did, as `gcal::push::Outcome` serialises it.
 *
 * `refused` is per-event and deliberately not folded into the counts: a
 * run reports what it could not do rather than failing whole, so an
 * outcome can be a success and a partial failure at once. Whoever
 * renders it owes both halves — see `pushGcal` in `App.tsx`.
 */
export interface PushOutcome {
  /** The calendar written to. Created by the first push, then remembered. */
  calendar: string;
  inserted: number;
  patched: number;
  deleted: number;
  refused: string[];
}

export const api = {
  /** Pass a date to see the plan as it stood then. */
  getState: (asof?: string | null) =>
    request(asof ? `/api/state?asof=${asof}` : "/api/state"),
  createTask: (task: NewTask) => request("/api/tasks", json("POST", task)),
  patchTask: (id: string, patch: TaskPatch) =>
    request(`/api/tasks/${id}`, json("PATCH", patch)),
  /** Write a task verbatim, clearing its tombstone — the undo-a-delete path. */
  putTask: (id: string, task: Task) =>
    request(`/api/tasks/${id}`, json("PUT", task)),
  deleteTask: (id: string) => request(`/api/tasks/${id}`, { method: "DELETE" }),
  reorder: (ids: string[]) =>
    request("/api/tasks/reorder", json("POST", { ids })),
  addDep: (dep: Dep) => request("/api/deps", json("POST", dep)),
  removeDep: (dep: Dep) =>
    request(`/api/deps/${dep.from}/${dep.to}`, { method: "DELETE" }),
  getPeers: () => peersRequest(),
  /**
   * Merge the active project into that peer's group. Mutual, and not
   * undoable — see `joinProject` for the reading that keeps them apart.
   *
   * The server syncs before answering, so the tasks are already here.
   */
  mergePeer: (ticket: string) =>
    peersRequest(
      { method: "POST", body: JSON.stringify({ ticket }) },
      "/api/peers/merge",
    ),
  /**
   * Cut the active project loose: forget its peers, mint a new room.
   *
   * Answers with the peer list *and* how many were dropped, because "you
   * left" and "you left a group of three" are different sentences and
   * only the server knows which one is true.
   */
  leavePeers: () =>
    fetch("/api/peers/leave", { method: "POST" }).then(async (res) => {
      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* non-JSON error body */
        }
        throw new ApiError(message, res.status);
      }
      return (await res.json()) as PeersInfo & { dropped: number };
    }),
  getProjects: () => projectsRequest(),
  /**
   * Point the server at another open project.
   *
   * Only a change of view — every open project is already replicating,
   * so there is nothing to start and nothing to wait for.
   */
  switchProject: (name: string) =>
    projectsRequest({ method: "POST", body: JSON.stringify({ name }) }),
  /**
   * Start a project and open it, without restarting.
   *
   * The server applies the same rules `yaiba new` does, so a name that
   * collides — outright or through the slug its database is named from —
   * comes back as a 409 rather than quietly landing on someone's tasks.
   */
  createProject: (name: string) =>
    projectsRequest(
      { method: "POST", body: JSON.stringify({ name }) },
      "/api/projects/new",
    ),
  /**
   * Take a peer's tasks as a project of their own, and open it.
   *
   * The safe half of what `:join` used to be: nothing you already have is
   * changed, and nothing of yours is shared with them. The server pulls
   * before answering, so the project comes back already populated.
   */
  joinProject: (ticket: string) =>
    projectsRequest(
      { method: "POST", body: JSON.stringify({ ticket }) },
      "/api/projects/join",
    ),
  /** Rename a project. Only the name moves; its database keeps its path. */
  renameProject: (from: string, to: string) =>
    projectsRequest(
      { method: "PATCH", body: JSON.stringify({ to }) },
      `/api/projects/${encodeURIComponent(from)}`,
    ),
  /** Close a project and drop it from the list. Its database stays. */
  forgetProject: (name: string) =>
    projectsRequest(
      { method: "DELETE" },
      `/api/projects/${encodeURIComponent(name)}`,
    ),
  /** The active project's remembered folds / focus / filter (`{}` when none). */
  getUi: () => uiRequest(),
  putUi: (ui: ProjectUiState) =>
    uiRequest({ method: "PUT", body: JSON.stringify(ui) }),
  /**
   * Make the active project's calendar say what the plan says.
   *
   * The one call in here that leaves the machine, so it is the one that
   * takes seconds rather than milliseconds: the server mints an access
   * token, creates the calendar on a first push, reads every event and
   * then reconciles one HTTP call at a time.
   *
   * A 412 is the setup not being done — no credential on this machine
   * (`yaiba gcal login`), or no OAuth client in the server's environment.
   * The server writes a sentence naming which, and it is shown verbatim.
   */
  pushGcal: () =>
    fetch("/api/gcal/push", { method: "POST" }).then(async (res) => {
      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* non-JSON error body */
        }
        throw new ApiError(message, res.status);
      }
      return (await res.json()) as PushOutcome;
    }),
};
