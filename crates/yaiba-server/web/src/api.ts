import type { AppData, Dep, NewTask, Task, TaskPatch } from "./types";

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

async function peersRequest(init?: RequestInit): Promise<PeersInfo> {
  const res = await fetch("/api/peers", {
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
  /** Adopt a peer's ticket; the server syncs before answering. */
  joinPeer: (ticket: string) =>
    peersRequest({ method: "POST", body: JSON.stringify({ ticket }) }),
};
