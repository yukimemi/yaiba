import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type PeersInfo, type ProjectsInfo } from "./api";
import { runCommand, type UiPatch, type View, type Zoom } from "./commands";
import {
  completionLine,
  startCompletion,
  stepCompletion,
  type Completion,
} from "./completion";
import { Gantt } from "./components/Gantt";
import { Help } from "./components/Help";
import { ProjectPalette } from "./components/ProjectPalette";
import { Hud } from "./components/Hud";
import { StatusLine, type Message } from "./components/StatusLine";
import { TaskList } from "./components/TaskList";
import { addDays } from "./dates";
import { visibleTasks, type SortKey } from "./filter";
import { MODE_HINT, type Mode } from "./mode";
import { applyTheme, initialTheme, type Theme } from "./theme";
import { applyOps, inversePatch, type Op, type Step } from "./ops";
import type { AppData, Dep, Status, Task, TaskPatch } from "./types";

/** How often to pick up edits merged in from peers. */
const REFRESH_MS = 3000;
/** Peer list refresh — peers join on a human timescale, not a UI one. */
const PEERS_MS = 15000;
const HALF_PAGE = 10;
const STATUS_CYCLE: Status[] = ["todo", "doing", "done"];

/** Held down rather than typed, so they never end a completion cycle. */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** Keys that only make sense as the first half of a two-key command. */
const PREFIXES = new Set(["d", "y", "g", "z", "c", ">", "<"]);

const NORMALIZE: Record<string, string> = {
  ArrowDown: "j",
  ArrowUp: "k",
  ArrowLeft: "h",
  ArrowRight: "l",
  Escape: "<esc>",
  Enter: "<cr>",
  Tab: "<tab>",
  " ": "<space>",
  Home: "gg",
  End: "G",
};

const VIEW_CYCLE: View[] = ["split", "list", "gantt"];
const ZOOM_CYCLE: Zoom[] = ["month", "week", "day"];

export function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [mode, setMode] = useState<Mode>("normal");
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [linkAnchor, setLinkAnchor] = useState<string | null>(null);
  const [pending, setPending] = useState("");
  const [cmdline, setCmdline] = useState("");
  /** The open `<tab>` cycle, or null when nothing is being completed. */
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(
    null,
  );
  /** An unsaved row being typed. See `openNew`. */
  const [draft, setDraft] = useState<{
    after: string | null;
    value: string;
  } | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [lastSearch, setLastSearch] = useState("");
  const [cutting, setCutting] = useState<Set<string>>(new Set());
  const [showHelp, setShowHelp] = useState(false);

  const [peers, setPeers] = useState<PeersInfo>({ ticket: null, peers: [] });

  const [projects, setProjects] = useState<ProjectsInfo>({ projects: [], active: "" });
  const [showProjects, setShowProjects] = useState(false);
  /**
   * The last project action to fail, shown *inside* the palette.
   *
   * The status line is not enough on its own: the palette is `position:
   * fixed; inset: 0` above it, so a `say()` while it is open lands
   * behind the overlay and the failure reads as nothing having happened.
   */
  const [projectError, setProjectError] = useState<string | null>(null);

  const [view, setView] = useState<View>("split");
  const [zoom, setZoom] = useState<Zoom>("day");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("manual");
  const [theme, setTheme] = useState<Theme>(initialTheme);
  /** Rows folded one at a time with za / zc. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Hide anything deeper than this; null shows every level. */
  const [foldLevel, setFoldLevel] = useState<number | null>(null);
  /** Show only this subtree — :only / zf. */
  const [focus, setFocus] = useState<string | null>(null);
  /**
   * The date the whole view is computed against. `null` means now.
   *
   * Kept in a ref as well because `load` runs from an interval and a
   * stale closure would silently snap the view back to today.
   */
  const [, setAsof] = useState<string | null>(null);

  const modeRef = useRef<Mode>("normal");
  /**
   * The half-typed key sequence, mirrored out of state for the same
   * reason as `modeRef`: `g` then `t` arrive faster than React
   * re-renders, so reading the state would still see "" on the second
   * key and `gt` would be lost. Two-key commands are exactly the ones
   * typed fastest.
   */
  const pendingRef = useRef("");
  const asofRef = useRef<string | null>(null);
  const listPane = useRef<HTMLDivElement>(null);
  const ganttPane = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);
  const undoStack = useRef<Step[]>([]);
  const redoStack = useRef<Step[]>([]);
  const register = useRef<Task[]>([]);
  const history = useRef<string[]>([]);
  const historyAt = useRef(0);

  // ---- derived ----------------------------------------------------

  const bySchedule = useMemo(
    () => new Map((data?.schedule.tasks ?? []).map((s) => [s.id, s])),
    [data],
  );
  const visible = useMemo(
    () =>
      data
        ? visibleTasks(data.tasks, bySchedule, {
            query: filter,
            sort,
            collapsed,
            foldLevel,
            focus,
          })
        : [],
    [data, bySchedule, filter, sort, collapsed, foldLevel, focus],
  );

  /** The progress line is noise on an empty plan; show it once there is
   *  something to compare. */
  const showProgressLine = (data?.tasks.length ?? 0) > 0;

  /** Deepest level present, so zr knows when it has fully unfolded. */
  const maxLevel = useMemo(
    () =>
      (data?.schedule.tasks ?? []).reduce((m, s) => Math.max(m, s.level), 0),
    [data],
  );

  const cursorAt = visible.findIndex((t) => t.id === cursorId);
  const cursor = cursorAt >= 0 ? cursorAt : 0;
  const current: Task | null = visible[cursor] ?? null;

  const selection = useMemo(() => {
    if (mode !== "visual" || !anchorId) return current ? [current] : [];
    const a = visible.findIndex((t) => t.id === anchorId);
    if (a < 0) return current ? [current] : [];
    const [lo, hi] = a <= cursor ? [a, cursor] : [cursor, a];
    return visible.slice(lo, hi + 1);
  }, [mode, anchorId, visible, cursor, current]);

  const selectedIds = useMemo(
    () => new Set(mode === "visual" ? selection.map((t) => t.id) : []),
    [mode, selection],
  );

  // ---- data -------------------------------------------------------

  const load = useCallback(async () => {
    try {
      const next = await api.getState(asofRef.current);
      setData(next);
      return next;
    } catch (e) {
      setMessage({ text: `offline: ${(e as Error).message}`, kind: "error" });
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Peers merge in the background, so the local view has to re-read.
  // Pausing while typing keeps a refresh from yanking the row you're
  // editing out from under the caret.
  useEffect(() => {
    if (mode !== "normal" && mode !== "visual") return;
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [mode, load]);

  useEffect(() => {
    if (!cursorId && visible.length) setCursorId(visible[0].id);
  }, [cursorId, visible]);

  // Peer roster, for the HUD. Slower than the data poll — peers come and
  // go on a human timescale.
  useEffect(() => {
    const read = () => {
      void api.getPeers().then(setPeers).catch(() => undefined);
      // Rides the same timer: the peer counts the project palette shows
      // move on the same human timescale as the HUD's.
      void api.getProjects().then(setProjects).catch(() => undefined);
    };
    read();
    const timer = setInterval(read, PEERS_MS);
    return () => clearInterval(timer);
  }, []);

  /**
   * Point the server at another project and re-read.
   *
   * Everything derived from the old project has to go with it: the cursor
   * names a task id that does not exist over there, and a filter or a
   * focused subtree carried across would silently hide the new project's
   * tasks and read as "the switch lost my data".
   */
  const switchTo = (name: string) => {
    setShowProjects(false);
    // Landing on the project you are already looking at must not cost you
    // your filter and folds: an <enter> straight out of the palette is a
    // no-op, not a reset.
    if (name === projects.active) return;
    void api
      .switchProject(name)
      .then((info) => {
        setProjects(info);
        setCursorId(null);
        setAnchorId(null);
        setFocus(null);
        // Both halves of the folding state. `foldLevel` is a raw depth
        // compared against each project's own tree, so carrying it over
        // hides everything deeper in the new one — the same failure the
        // filter reset above exists to prevent.
        setFoldLevel(null);
        setCollapsed(new Set());
        setFilter("");
        return load();
      })
      .then(() => say(`project · ${name}`, "ok"))
      .catch((e: Error) => failProject(e));
  };

  /**
   * Adopt a new project list *and* forget everything derived from the old
   * project, for the paths that also change which database is served.
   *
   * Creating a project and forgetting the one you were looking at both
   * land you somewhere else, so they owe the same reset a switch does: a
   * filter or a fold depth carried across would silently hide the new
   * project's tasks and read as the operation having lost them.
   */
  /**
   * Report a project action that failed, to both places it can be read.
   *
   * The status line alone is not enough while the palette is up — it sits
   * under a `position: fixed; inset: 0` overlay, so the message is there
   * and invisible, and the failure reads as nothing having happened.
   */
  const failProject = (e: Error) => {
    setProjectError(e.message);
    say(e.message, "error");
  };

  const adoptProjects = (info: ProjectsInfo, note: string) => {
    setProjects(info);
    setShowProjects(false);
    setCursorId(null);
    setAnchorId(null);
    setFocus(null);
    setFoldLevel(null);
    setCollapsed(new Set());
    setFilter("");
    void load().then(() => say(note, "ok"));
  };

  const createProject = (name: string) => {
    void api
      .createProject(name)
      .then((info) => adoptProjects(info, `project · ${info.active} (new)`))
      .catch((e: Error) => failProject(e));
  };

  const renameProject = (from: string, to: string) => {
    void api
      .renameProject(from, to)
      .then((info) => {
        setProjects(info);
        setShowProjects(false);
        // Not a switch: same database, same tasks. So the view keeps its
        // cursor, filter and folds — resetting them here would be the
        // "switch lost my data" surprise for an operation that changed
        // nothing but a label.
        say(`renamed ${from} → ${to}`, "ok");
      })
      .catch((e: Error) => failProject(e));
  };

  const forgetProject = (name: string) => {
    void api
      .forgetProject(name)
      .then((info) =>
        adoptProjects(
          info,
          `forgot ${name} · database still on disk · now on ${info.active}`,
        ),
      )
      .catch((e: Error) => failProject(e));
  };

  const say = (text: string, kind: Message["kind"] = "info") =>
    setMessage({ text, kind });

  /**
   * Switch modes, keeping a ref in lockstep with the state.
   *
   * Keystrokes can arrive faster than React re-renders — a quick `o`
   * followed immediately by typing, or any burst input. The key handler
   * reads `modeRef`, so it can't still believe it is in normal mode and
   * eat the first characters of a new task as commands.
   */
  const enterMode = useCallback((next: Mode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  /** Set the pending key sequence, keeping the ref in lockstep. */
  const setPendingKeys = useCallback((next: string) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  /** Move the reference date, then reload against it. */
  const setReferenceDate = useCallback(
    (date: string | null) => {
      asofRef.current = date;
      setAsof(date);
      void load();
    },
    [load],
  );

  /**
   * Mirror one pane's vertical scroll onto the other.
   *
   * The two panes render the same rows at the same height, so they only
   * stay aligned if they scroll together — otherwise row 20's bar sits
   * next to row 8's title. The flag breaks the feedback loop where each
   * scroll triggers the other's handler.
   */
  const syncScroll = useCallback(
    (from: React.RefObject<HTMLDivElement | null>) => () => {
      const source = from.current;
      const target = (from === listPane ? ganttPane : listPane).current;
      if (!source || !target || syncingScroll.current) return;
      syncingScroll.current = true;
      target.scrollTop = source.scrollTop;
      requestAnimationFrame(() => {
        syncingScroll.current = false;
      });
    },
    [],
  );

  /**
   * Refuse writes while the view is pinned to another date.
   *
   * Editing then would apply a change computed from stale values to the
   * live store — pressing `x` on a row that was todo back then but is
   * done now would silently reopen it. The historical view is a report;
   * come back to now to act on it.
   *
   * Every write path calls this. Guarding only `run()` left `o`,
   * `p`, `u` and `^r` open, because they reach the API directly.
   */
  const liveOnly = useCallback((): boolean => {
    if (!asofRef.current) return true;
    say("viewing the past — :asof today to make changes", "error");
    return false;
  }, []);

  /** Run ops, record them for undo, and refresh from the response. */
  const run = useCallback(
    async (ops: Op[], undo: Op[], label: string): Promise<AppData | null> => {
      if (!liveOnly()) return null;
      try {
        const next = await applyOps(ops);
        setData(next);
        undoStack.current.push({ redo: ops, undo, label });
        redoStack.current = [];
        return next;
      } catch (e) {
        setMessage({ text: (e as Error).message, kind: "error" });
        void load();
        return null;
      }
    },
    [load, liveOnly],
  );

  const patchAll = useCallback(
    (tasks: Task[], build: (task: Task) => TaskPatch, label: string) => {
      if (!tasks.length) return;
      const ops: Op[] = [];
      const undo: Op[] = [];
      for (const task of tasks) {
        const patch = build(task);
        ops.push({ kind: "patch", id: task.id, patch });
        undo.push({
          kind: "patch",
          id: task.id,
          patch: inversePatch(task, patch),
        });
      }
      void run(ops, undo, label);
    },
    [run],
  );

  /**
   * Nest rows under the sibling above them — the outliner convention.
   *
   * The anchor is the nearest preceding row at the same level, which is
   * what "the one above" means visually. A row with nothing above it at
   * its level has nowhere to go, and says so rather than silently doing
   * nothing.
   */
  const indent = useCallback(
    (tasks: Task[]) => {
      if (!tasks.length) return;
      const ops: Op[] = [];
      const undo: Op[] = [];
      for (const task of tasks) {
        const index = visible.findIndex((t) => t.id === task.id);
        const level = bySchedule.get(task.id)?.level ?? 0;
        let anchor: string | null = null;
        for (let i = index - 1; i >= 0; i -= 1) {
          const candidate = visible[i];
          const candidateLevel = bySchedule.get(candidate.id)?.level ?? 0;
          if (candidateLevel === level) {
            anchor = candidate.id;
            break;
          }
          // Reached a shallower row: this is the first child here.
          if (candidateLevel < level) break;
        }
        if (!anchor) continue;
        ops.push({ kind: "patch", id: task.id, patch: { parent: anchor } });
        undo.push({
          kind: "patch",
          id: task.id,
          patch: { parent: task.parent },
        });
      }
      if (!ops.length) {
        say("nothing above to nest under", "error");
        return;
      }
      void run(ops, undo, "indent");
    },
    [visible, bySchedule, run],
  );

  /** Move rows up one level, to their grandparent. */
  const outdent = useCallback(
    (tasks: Task[]) => {
      if (!data || !tasks.length) return;
      const byId = new Map(data.tasks.map((t) => [t.id, t]));
      const ops: Op[] = [];
      const undo: Op[] = [];
      for (const task of tasks) {
        if (!task.parent) continue;
        const grandparent = byId.get(task.parent)?.parent ?? null;
        ops.push({
          kind: "patch",
          id: task.id,
          patch: { parent: grandparent },
        });
        undo.push({
          kind: "patch",
          id: task.id,
          patch: { parent: task.parent },
        });
      }
      if (!ops.length) {
        say("already at the top level", "error");
        return;
      }
      void run(ops, undo, "outdent");
    },
    [data, run],
  );

  /**
   * Create a task and hand back its server-assigned id.
   *
   * The id is discovered by diffing against the previous state rather
   * than minted here, so the manual `position` the server computes for
   * `after` stays authoritative.
   */
  const createTask = useCallback(
    async (title: string, after: string | null, label: string) => {
      if (!liveOnly()) return null;
      const known = new Set((data?.tasks ?? []).map((t) => t.id));
      try {
        const next = await api.createTask({ title, after });
        setData(next);
        const created = next.tasks.find((t) => !known.has(t.id));
        if (created) {
          undoStack.current.push({
            redo: [{ kind: "restore", task: created, deps: [] }],
            undo: [{ kind: "delete", id: created.id }],
            label,
          });
          redoStack.current = [];
        }
        return created ?? null;
      } catch (e) {
        setMessage({ text: (e as Error).message, kind: "error" });
        return null;
      }
    },
    [data, liveOnly],
  );

  /**
   * Open an unsaved row and enter insert mode *immediately*.
   *
   * The task is only POSTed on commit. Creating it first put a network
   * round trip between `o` and the caret appearing, and every character
   * typed in that window was swallowed as a normal-mode command — which
   * is exactly the moment a fast typist is already typing.
   */
  const openNew = useCallback((after: string | null) => {
    setDraft({ after, value: "" });
    enterMode("insert");
  }, []);

  const commitDraft = useCallback(
    async (openNext: boolean) => {
      const pending = draft;
      setDraft(null);
      enterMode("normal");
      if (!pending) return;

      const title = pending.value.trim();
      // An empty row is a cancelled thought, not a task.
      if (!title) return;
      const created = await createTask(title, pending.after, "new task");
      if (created) setCursorId(created.id);
      if (openNext) {
        setDraft({ after: created?.id ?? pending.after, value: "" });
        enterMode("insert");
      }
    },
    [draft, createTask],
  );

  // ---- actions ----------------------------------------------------

  const flash = (ids: string[]) => {
    setCutting(new Set(ids));
    window.setTimeout(() => setCutting(new Set()), 400);
  };

  const toggleDone = useCallback(
    (tasks: Task[]) => {
      if (!tasks.length) return;
      // A mixed selection completes rather than toggling each row —
      // "finish these" is the intent behind pressing x on a block.
      const allDone = tasks.every((t) => t.status === "done");
      if (!allDone) flash(tasks.map((t) => t.id));
      patchAll(
        tasks,
        () =>
          allDone
            ? { status: "todo", progress: 0 }
            : { status: "done", progress: 100 },
        allDone ? "reopen" : "done",
      );
    },
    [patchAll],
  );

  const moveTo = useCallback(
    (index: number) => {
      if (!visible.length) return;
      const clamped = Math.min(Math.max(index, 0), visible.length - 1);
      setCursorId(visible[clamped].id);
    },
    [visible],
  );

  /** Reorder the manual list by moving the cursor row `delta` places. */
  const moveRow = useCallback(
    (delta: number) => {
      if (!current || !data) return;
      if (sort !== "manual") {
        say("rows only move in manual order — :sort manual", "error");
        return;
      }
      if (filter) {
        say("clear the filter before moving rows — :f", "error");
        return;
      }
      const ids = data.tasks.map((t) => t.id);
      const from = ids.indexOf(current.id);
      const to = Math.min(Math.max(from + delta, 0), ids.length - 1);
      if (from === to) return;
      const next = [...ids];
      next.splice(to, 0, ...next.splice(from, 1));
      void run(
        [{ kind: "reorder", ids: next }],
        [{ kind: "reorder", ids }],
        "move",
      );
    },
    [current, data, sort, filter, run],
  );

  const deleteSelection = useCallback(
    (tasks: Task[]) => {
      if (!tasks.length || !data) return;
      const below = visible[Math.min(cursor + tasks.length, visible.length - 1)];
      register.current = tasks;
      void run(
        tasks.map((t) => ({ kind: "delete", id: t.id })),
        tasks.map((t) => ({
          kind: "restore",
          task: t,
          deps: data.deps.filter((d) => d.from === t.id || d.to === t.id),
        })),
        `delete ${tasks.length}`,
      );
      enterMode("normal");
      setAnchorId(null);
      if (below && !tasks.some((t) => t.id === below.id)) setCursorId(below.id);
    },
    [data, visible, cursor, run],
  );

  const paste = useCallback(
    async (after: string | null) => {
      if (!liveOnly()) return;
      if (!register.current.length) {
        say("nothing yanked", "error");
        return;
      }
      let anchor = after;
      for (const task of register.current) {
        const created = await createTask(task.title, anchor, "paste");
        if (!created) break;
        anchor = created.id;
        await api
          .patchTask(created.id, {
            notes: task.notes,
            priority: task.priority,
            start: task.start,
            duration_days: task.duration_days,
            due: task.due,
            tags: task.tags,
          })
          .then(setData)
          .catch(() => undefined);
        setCursorId(created.id);
      }
      say(`pasted ${register.current.length}`, "ok");
    },
    [createTask, liveOnly],
  );

  const undo = useCallback(async () => {
    if (!liveOnly()) return;
    const step = undoStack.current.pop();
    if (!step) {
      say("already at the oldest change");
      return;
    }
    try {
      setData(await applyOps(step.undo));
      redoStack.current.push(step);
      say(`undo: ${step.label}`, "ok");
    } catch (e) {
      setMessage({ text: (e as Error).message, kind: "error" });
      void load();
    }
  }, [load, liveOnly]);

  const redo = useCallback(async () => {
    if (!liveOnly()) return;
    const step = redoStack.current.pop();
    if (!step) {
      say("already at the newest change");
      return;
    }
    try {
      setData(await applyOps(step.redo));
      undoStack.current.push(step);
      say(`redo: ${step.label}`, "ok");
    } catch (e) {
      setMessage({ text: (e as Error).message, kind: "error" });
      void load();
    }
  }, [load, liveOnly]);

  const jumpToMatch = useCallback(
    (term: string, from: number, direction: 1 | -1) => {
      if (!term || !visible.length) return;
      const needle = term.toLowerCase();
      for (let i = 1; i <= visible.length; i += 1) {
        const index =
          (from + direction * i + visible.length * i) % visible.length;
        const task = visible[index];
        if (
          task.title.toLowerCase().includes(needle) ||
          task.tags.some((t) => t.toLowerCase().includes(needle))
        ) {
          setCursorId(task.id);
          return;
        }
      }
      say(`pattern not found: ${term}`, "error");
    },
    [visible],
  );

  const applyUi = useCallback((ui: UiPatch) => {
    if (ui.view) setView(ui.view);
    if (ui.focus !== undefined) setFocus(ui.focus);
    if (ui.asof !== undefined) setReferenceDate(ui.asof);
    if (ui.theme) {
      setTheme((prev) => {
        const next =
          ui.theme === "toggle" ? (prev === "dark" ? "light" : "dark") : ui.theme!;
        applyTheme(next);
        say(next === "light" ? "office mode" : "neon mode");
        return next;
      });
    }
    if (ui.foldLevel !== undefined) setFoldLevel(ui.foldLevel);
    if (ui.zoom) setZoom(ui.zoom);
    if (ui.filter !== undefined) setFilter(ui.filter);
    if (ui.sort) setSort(ui.sort);
    if (ui.help) setShowHelp(true);
    if (ui.quit) {
      // Only works for script-opened tabs; say so instead of failing
      // silently.
      window.close();
      say("close the tab to quit — the server keeps running", "info");
    }
  }, []);

  const commitLink = useCallback(
    (remove: boolean) => {
      if (!linkAnchor || !current || !data) return;
      if (current.id === linkAnchor) {
        say("a task can't depend on itself", "error");
        return;
      }
      // The anchor is the task that waits; the row you land on is what
      // it waits for.
      const dep = { from: current.id, to: linkAnchor };
      const exists = data.deps.some(
        (d) => d.from === dep.from && d.to === dep.to,
      );
      if (remove && !exists) {
        say("no dependency between those two", "error");
        return;
      }
      if (!remove && exists) {
        say("already linked", "error");
        return;
      }
      void run(
        [remove ? { kind: "removeDep", dep } : { kind: "addDep", dep }],
        [remove ? { kind: "addDep", dep } : { kind: "removeDep", dep }],
        remove ? "unlink" : "link",
      );
      enterMode("normal");
      setLinkAnchor(null);
      setCursorId(linkAnchor);
    },
    [linkAnchor, current, data, run],
  );

  // ---- mouse ------------------------------------------------------
  //
  // Every one of these maps onto a key: clicking a row is `j`/`k` to it,
  // the checkbox is `x`, the marker is `za`, a double-click is `i`, and
  // dragging a row is `J`/`K`. Sharing the same actions keeps the two
  // input methods from drifting apart.

  const onPick = useCallback((id: string) => setCursorId(id), []);

  const onToggleDone = useCallback(
    (id: string) => {
      const task = visible.find((t) => t.id === id);
      if (task) toggleDone([task]);
    },
    [visible, toggleDone],
  );

  const onToggleFold = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onEditTitle = useCallback(
    (id: string) => {
      const task = visible.find((t) => t.id === id);
      if (!task) return;
      setCursorId(id);
      setEditing({ id, value: task.title });
      enterMode("insert");
    },
    [visible, enterMode],
  );

  /** Drop `dragged` where `target` sits in the manual order. */
  const onDropRow = useCallback(
    (draggedId: string, targetId: string) => {
      if (!data) return;
      if (sort !== "manual") {
        say("rows only move in manual order — :sort manual", "error");
        return;
      }
      const ids = data.tasks.map((t) => t.id);
      const from = ids.indexOf(draggedId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return;
      const next = [...ids];
      next.splice(to, 0, ...next.splice(from, 1));
      void run(
        [{ kind: "reorder", ids: next }],
        [{ kind: "reorder", ids }],
        "move",
      );
    },
    [data, sort, run],
  );

  /**
   * Drag a bar sideways: pin its start.
   *
   * The bar may have had no `start` of its own — it was placed by its
   * dependencies. Dragging it means "I want it here", so the computed
   * date becomes an explicit pin, which is also what makes the gesture
   * survive the next recompute.
   */
  const onMoveBar = useCallback(
    (id: string, days: number) => {
      const task = visible.find((t) => t.id === id);
      const sched = bySchedule.get(id);
      if (!task || !sched) return;
      const next = addDays(sched.start, days);
      void run(
        [{ kind: "patch", id, patch: { start: next } }],
        [{ kind: "patch", id, patch: { start: task.start } }],
        `start ${next}`,
      );
    },
    [visible, bySchedule, run],
  );

  const onResizeBar = useCallback(
    (id: string, days: number) => {
      const task = visible.find((t) => t.id === id);
      if (!task) return;
      const next = Math.max(task.duration_days + days, 1);
      if (next === task.duration_days) return;
      void run(
        [{ kind: "patch", id, patch: { duration_days: next } }],
        [{ kind: "patch", id, patch: { duration_days: task.duration_days } }],
        `${next}d`,
      );
    },
    [visible, run],
  );

  const onLinkBars = useCallback(
    (from: string, to: string) => {
      const dep = { from, to };
      if (data?.deps.some((d) => d.from === from && d.to === to)) {
        say("already linked", "error");
        return;
      }
      void run(
        [{ kind: "addDep", dep }],
        [{ kind: "removeDep", dep }],
        "link",
      );
    },
    [data, run],
  );

  const onUnlinkDep = useCallback(
    (dep: Dep) => {
      void run(
        [{ kind: "removeDep", dep }],
        [{ kind: "addDep", dep }],
        "unlink",
      );
    },
    [run],
  );

  // ---- key handling -----------------------------------------------

  const onKey = (e: KeyboardEvent) => {
    // Read the ref, not the state: see enterMode.
    const activeMode = modeRef.current;
    // The palette runs its own input and owns every key while it is up,
    // exactly as insert / command / search do.
    if (showProjects) return;
    if (showHelp) {
      if (e.key === "Escape" || e.key === "?" || e.key === "Enter") {
        setShowHelp(false);
        e.preventDefault();
      }
      return;
    }
    // Insert / command / search live in their own <input>; those
    // handlers own the keystroke.
    if (activeMode === "insert" || activeMode === "command" || activeMode === "search") return;

    if (e.ctrlKey || e.metaKey) {
      if (e.ctrlKey && !e.metaKey) {
        if (e.key === "d") moveTo(cursor + HALF_PAGE);
        else if (e.key === "u") moveTo(cursor - HALF_PAGE);
        else if (e.key === "r") void redo();
        else return;
        e.preventDefault();
      }
      return;
    }
    if (e.altKey) return;

    const key = NORMALIZE[e.key] ?? e.key;
    if (key.length > 1 && !key.startsWith("<")) return;

    const buf = pendingRef.current + key;
    const match = /^([1-9]\d*)?(.*)$/.exec(buf);
    const count = match?.[1] ? Number(match[1]) : 1;
    const cmd = match?.[2] ?? "";

    e.preventDefault();

    if (cmd === "" || (cmd.length === 1 && PREFIXES.has(cmd))) {
      setPendingKeys(buf);
      return;
    }
    setPendingKeys("");
    setMessage(null);

    switch (cmd) {
      // ---- motion
      case "j":
        moveTo(cursor + count);
        break;
      case "k":
        moveTo(cursor - count);
        break;
      case "gg":
        moveTo(match?.[1] ? count - 1 : 0);
        break;
      case "G":
        moveTo(match?.[1] ? count - 1 : visible.length - 1);
        break;
      case "H":
        moveTo(0);
        break;
      case "M":
        moveTo(Math.floor(visible.length / 2));
        break;
      case "L":
        moveTo(visible.length - 1);
        break;

      // ---- modes
      case "<esc>":
        enterMode("normal");
        setAnchorId(null);
        setLinkAnchor(null);
        break;
      case "v":
        if (activeMode === "visual") {
          enterMode("normal");
          setAnchorId(null);
        } else if (current) {
          enterMode("visual");
          setAnchorId(current.id);
        }
        break;
      case ":":
        setCmdline("");
        setCompletion(null);
        historyAt.current = history.current.length;
        enterMode("command");
        break;
      case "/":
        setCmdline("");
        enterMode("search");
        break;
      case "n":
        jumpToMatch(lastSearch, cursor, 1);
        break;
      case "N":
        jumpToMatch(lastSearch, cursor, -1);
        break;
      case "?":
        setShowHelp(true);
        break;

      // ---- editing
      case "o":
        openNew(current?.id ?? null);
        break;
      case "O":
        openNew(visible[cursor - 1]?.id ?? null);
        break;
      case "i":
      case "a":
      case "A":
      case "cc":
        if (current) {
          setEditing({ id: current.id, value: current.title });
          enterMode("insert");
        }
        break;
      case "<space>":
      case "x":
        toggleDone(selection);
        if (activeMode === "visual") {
          enterMode("normal");
          setAnchorId(null);
        }
        break;
      case "s":
        patchAll(
          selection,
          (task) => ({
            status:
              STATUS_CYCLE[
                (STATUS_CYCLE.indexOf(task.status) + 1) % STATUS_CYCLE.length
              ],
          }),
          "status",
        );
        break;
      case "dd":
        deleteSelection(selection);
        break;
      case "yy":
        register.current = selection;
        say(`yanked ${selection.length}`, "ok");
        if (activeMode === "visual") {
          enterMode("normal");
          setAnchorId(null);
        }
        break;
      case "p":
        void paste(current?.id ?? null);
        break;
      case "P":
        void paste(visible[cursor - 1]?.id ?? null);
        break;
      case "J":
        moveRow(count);
        break;
      case "K":
        moveRow(-count);
        break;
      case "u":
        void undo();
        break;

      // ---- planning
      case "+":
      case "=":
        patchAll(
          selection,
          (task) => ({ duration_days: task.duration_days + count }),
          "duration",
        );
        break;
      case "-":
        patchAll(
          selection,
          (task) => ({
            duration_days: Math.max(1, task.duration_days - count),
          }),
          "duration",
        );
        break;
      case "gp":
        patchAll(
          selection,
          (task) => ({ priority: Math.min(3, task.priority + 1) }),
          "priority",
        );
        break;
      case "gP":
        patchAll(
          selection,
          (task) => ({ priority: Math.max(0, task.priority - 1) }),
          "priority",
        );
        break;
      case ")":
        patchAll(
          selection,
          (task) => ({ progress: Math.min(100, task.progress + 10) }),
          "progress",
        );
        break;
      case "(":
        patchAll(
          selection,
          (task) => ({ progress: Math.max(0, task.progress - 10) }),
          "progress",
        );
        break;

      // ---- dependencies
      case "D":
        if (current) {
          setLinkAnchor(current.id);
          enterMode("link");
          say("pick what this task waits for — ⏎ to confirm");
        }
        break;
      case "X":
        if (current) {
          setLinkAnchor(current.id);
          enterMode("unlink");
          say("pick the dependency to cut — ⏎ to confirm");
        }
        break;
      case "<cr>":
        if (activeMode === "link") commitLink(false);
        else if (activeMode === "unlink") commitLink(true);
        break;

      // ---- view
      case "<tab>":
        setView(VIEW_CYCLE[(VIEW_CYCLE.indexOf(view) + 1) % VIEW_CYCLE.length]);
        break;
      case "]":
        setZoom(
          ZOOM_CYCLE[
            Math.min(ZOOM_CYCLE.indexOf(zoom) + 1, ZOOM_CYCLE.length - 1)
          ],
        );
        break;
      case "[":
        setZoom(ZOOM_CYCLE[Math.max(ZOOM_CYCLE.indexOf(zoom) - 1, 0)]);
        break;
      // ---- folding: the "level" axis
      case "zm":
        // Fold one level shallower. From "everything visible" that means
        // starting at the deepest level actually present, so the first
        // press always does something.
        setFoldLevel((prev) => Math.max((prev ?? maxLevel) - 1, 0));
        break;
      case "zr":
        setFoldLevel((prev) =>
          prev === null || prev + 1 >= maxLevel ? null : prev + 1,
        );
        break;
      case "zM":
        setFoldLevel(0);
        break;
      case "zR":
        setFoldLevel(null);
        setCollapsed(new Set());
        break;
      case "za":
      case "zo":
      case "zc": {
        if (!current) break;
        const wantOpen = cmd === "zo";
        const wantClose = cmd === "zc";
        setCollapsed((prev) => {
          const next = new Set(prev);
          const isClosed = next.has(current.id);
          if (wantOpen || (cmd === "za" && isClosed)) next.delete(current.id);
          else if (wantClose || cmd === "za") next.add(current.id);
          return next;
        });
        break;
      }
      case "zf":
        // Zoom into this subtree and drop every fold, so the focused
        // project opens fully rather than inheriting the outer view.
        if (current) {
          setFocus(current.id);
          setFoldLevel(null);
          say(`focused “${current.title}” — zF to come back`);
        }
        break;
      case "zF":
        setFocus(null);
        say("showing everything");
        break;

      // ---- the breakdown itself
      case ">>":
        indent(selection);
        break;
      case "<<":
        outdent(selection);
        break;

      case "gt":
        applyUi({ theme: "toggle" });
        break;

      case "R":
        void load();
        say("reloaded", "ok");
        break;

      default:
        break;
    }
  };

  // The handler closes over a lot of state; keeping it in a ref means
  // one listener for the life of the app instead of a re-subscribe on
  // every keystroke.
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);


  // ---- inline title editing ---------------------------------------

  const finishEdit = useCallback(
    async (commit: boolean) => {
      const active = editing;
      setEditing(null);
      enterMode("normal");
      if (!active || !commit) return;

      const title = active.value.trim();
      const before = data?.tasks.find((t) => t.id === active.id);
      // A blank title would leave an unreadable row; keep the old one.
      if (!before || !title || before.title === title) return;
      await run(
        [{ kind: "patch", id: active.id, patch: { title } }],
        [{ kind: "patch", id: active.id, patch: { title: before.title } }],
        "retitle",
      );
    },
    [editing, data, run],
  );

  const onEditKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      void finishEdit(true);
    }
    e.stopPropagation();
  };

  const onDraftKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Enter commits and opens the next row — the way you actually
      // enter a list of things in one sitting. Esc stops.
      void commitDraft(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      void commitDraft(false);
    }
    e.stopPropagation();
  };

  // ---- command line -----------------------------------------------

  /**
   * Open the `<tab>` cycle, or walk the open one. `step` is +1 for
   * `<tab>` and -1 for `<s-tab>`; from a closed menu -1 opens it on the
   * last match, which is what wrapping through "as typed" gives you.
   */
  const cycleCompletion = (step: number) => {
    if (!data) return;
    const from = completion ?? startCompletion(cmdline, { data, projects: projects.projects.map((p) => p.name) });
    if (!from) return;
    const next = stepCompletion(from, step);
    setCompletion(next);
    setCmdline(completionLine(next));
  };

  const onCmdKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      // The first esc only closes the menu — the line you were typing
      // survives, and a second esc leaves the command line.
      if (completion) {
        setCompletion(null);
        return;
      }
      enterMode("normal");
      setCmdline("");
      setSearchTerm("");
      return;
    }
    if (e.key === "Tab") {
      // Search has nothing to complete, but tab still must not move
      // focus out of the input and strand a half-typed search.
      e.preventDefault();
      if (mode === "command") cycleCompletion(e.shiftKey ? -1 : 1);
      return;
    }
    if (mode === "command" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const step = e.key === "ArrowUp" ? -1 : 1;
      // With the menu up the arrows belong to it, the way they do in a
      // popup; history is what they mean the rest of the time.
      if (completion) {
        cycleCompletion(step);
        return;
      }
      const next = Math.min(
        Math.max(historyAt.current + step, 0),
        history.current.length,
      );
      historyAt.current = next;
      setCmdline(history.current[next] ?? "");
      return;
    }
    if (e.key !== "Enter") {
      // Anything else ends the cycle, the way it does in vim — except a
      // bare modifier, since <s-tab> arrives as Shift and then Tab and
      // closing on the Shift would restart the cycle forwards.
      if (completion && !MODIFIERS.has(e.key)) setCompletion(null);
      return;
    }
    e.preventDefault();
    const line = cmdline;
    setCmdline("");
    setCompletion(null);
    enterMode("normal");

    if (mode === "search") {
      setLastSearch(line);
      setSearchTerm(line);
      jumpToMatch(line, cursor - 1, 1);
      return;
    }

    history.current.push(line);
    historyAt.current = history.current.length;
    if (!data) return;

    const result = runCommand(line, {
      data,
      visible,
      current,
      selection,
      projects: projects.projects.map((p) => p.name),
    });
    if (!result) return;
    if (result.error) {
      say(result.error, "error");
      return;
    }
    if (result.ui) applyUi(result.ui);
    if (result.peer?.showTicket) {
      if (!peers.ticket) {
        say("sync is off — started with --no-sync", "error");
      } else {
        // Copying is best-effort: it needs a secure context, which
        // plain http://localhost happens to qualify as, but a LAN
        // address would not.
        void navigator.clipboard
          ?.writeText(peers.ticket)
          .then(() => say(`ticket copied · ${peers.ticket}`, "ok"))
          .catch(() => say(peers.ticket ?? "", "ok"));
      }
    }
    if (result.peer?.join) {
      void api
        .joinPeer(result.peer.join)
        .then((info) => {
          setPeers(info);
          say(`joined · ${info.peers.length} peer(s)`, "ok");
          void load();
        })
        .catch((e: Error) => say(e.message, "error"));
    }
    if (result.project?.pick) {
      if (projects.projects.length < 2) {
        say("only one project is open — `yaiba join <ticket>` adds another", "info");
      } else {
        setProjectError(null);
        setShowProjects(true);
      }
    }
    if (result.project?.switch) switchTo(result.project.switch);
    if (result.project?.create) createProject(result.project.create);
    if (result.project?.forget) forgetProject(result.project.forget);
    if (result.project?.rename) renameProject(projects.active, result.project.rename);
    if (result.ops) {
      void run(result.ops, result.undoOps ?? [], result.label ?? line);
    }
    if (result.message) say(result.message, result.ops ? "ok" : "info");
    setAnchorId(null);
    if (mode === "visual") enterMode("normal");
  };

  // ---- render -----------------------------------------------------

  if (!data) {
    return (
      <div className="app">
        <p className="empty">connecting to the local replica…</p>
      </div>
    );
  }

  // Where the unsaved row sits in the visible list: right after its
  // anchor, or at the top when there is none (`O` on the first row).
  const draftIndex = draft
    ? draft.after
      ? Math.max(visible.findIndex((t) => t.id === draft.after) + 1, 0)
      : 0
    : -1;

  const rangeStart = addDays(
    data.schedule.start < data.today ? data.schedule.start : data.today,
    -3,
  );
  const rangeEnd = addDays(
    data.schedule.end > data.today ? data.schedule.end : data.today,
    zoom === "day" ? 7 : 30,
  );

  return (
    <div className="app">
      <Hud
        mode={mode}
        tasks={data.tasks}
        visibleCount={visible.length}
        criticalCount={data.schedule.critical_path.length}
        nodeId={data.node_id}
        filter={filter}
        projectEnd={data.schedule.end}
        peerCount={peers.peers.length}
        syncOn={peers.ticket !== null}
        asof={data.as_of ? data.today : null}
        foldLevel={foldLevel}
        theme={theme}
        project={projects.active}
        projectCount={projects.projects.length}
        onOpenProjects={() => {
          setProjectError(null);
          setShowProjects(true);
        }}
        onToggleTheme={() => applyUi({ theme: "toggle" })}
        focusTitle={
          focus ? (data.tasks.find((t) => t.id === focus)?.title ?? null) : null
        }
      />

      <div className="panes">
        {view !== "gantt" && (
          <TaskList
            tasks={visible}
            bySchedule={bySchedule}
            cursor={cursor}
            selected={selectedIds}
            editing={editing}
            onEditChange={(value) =>
              setEditing((prev) => (prev ? { ...prev, value } : prev))
            }
            onEditKey={onEditKey}
            draftIndex={draftIndex}
            draftValue={draft?.value ?? ""}
            onDraftChange={(value) =>
              setDraft((prev) => (prev ? { ...prev, value } : prev))
            }
            onDraftKey={onDraftKey}
            searchTerm={searchTerm}
            cutting={cutting}
            linkAnchor={linkAnchor}
            onlyPane={view === "list"}
            emptyHint={
              filter ? "nothing matches this filter." : "no tasks yet."
            }
            sort={sort}
            collapsed={collapsed}
            paneRef={listPane}
            onScroll={syncScroll(listPane)}
            onPick={onPick}
            onToggleDone={onToggleDone}
            onToggleFold={onToggleFold}
            onEditTitle={onEditTitle}
            onDropRow={onDropRow}
          />
        )}
        {view !== "list" && (
          <Gantt
            tasks={visible}
            bySchedule={bySchedule}
            deps={data.deps}
            cursor={cursor}
            today={data.today}
            zoom={zoom}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onlyPane={view === "gantt"}
            paneRef={ganttPane}
            onScroll={syncScroll(ganttPane)}
            showProgressLine={showProgressLine}
            onPick={onPick}
            onMoveBar={onMoveBar}
            onResizeBar={onResizeBar}
            onLinkBars={onLinkBars}
            onUnlinkDep={onUnlinkDep}
          />
        )}
      </div>

      <StatusLine
        mode={mode}
        cmdline={cmdline}
        onCmdChange={(value) => {
          setCmdline(value);
          // Covers the edits no keydown announces — a mouse paste, an
          // IME commit — which would otherwise leave a stale menu up.
          setCompletion(null);
          if (mode === "search") setSearchTerm(value);
        }}
        onCmdKey={onCmdKey}
        completion={completion}
        message={message}
        pending={pending}
        hint={MODE_HINT[mode]}
      />

      {showHelp && <Help onClose={() => setShowHelp(false)} />}
      {showProjects && (
        <ProjectPalette
          projects={projects.projects}
          active={projects.active}
          onPick={switchTo}
          onCreate={createProject}
          onRename={renameProject}
          onForget={forgetProject}
          error={projectError}
          onDismissError={() => setProjectError(null)}
          onClose={() => {
            setShowProjects(false);
            setProjectError(null);
          }}
        />
      )}
    </div>
  );
}
