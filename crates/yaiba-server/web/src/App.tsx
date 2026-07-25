import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type PeersInfo } from "./api";
import { runCommand, type UiPatch, type View, type Zoom } from "./commands";
import { Gantt } from "./components/Gantt";
import { Help } from "./components/Help";
import { Hud } from "./components/Hud";
import { StatusLine, type Message } from "./components/StatusLine";
import { TaskList } from "./components/TaskList";
import { addDays } from "./dates";
import { visibleTasks, type SortKey } from "./filter";
import { MODE_HINT, type Mode } from "./mode";
import { applyOps, inversePatch, type Op, type Step } from "./ops";
import type { AppData, Status, Task, TaskPatch } from "./types";

/** How often to pick up edits merged in from peers. */
const REFRESH_MS = 3000;
/** Peer list refresh — peers join on a human timescale, not a UI one. */
const PEERS_MS = 15000;
const HALF_PAGE = 10;
const STATUS_CYCLE: Status[] = ["todo", "doing", "done"];

/** Keys that only make sense as the first half of a two-key command. */
const PREFIXES = new Set(["d", "y", "g", "z", "c"]);

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

  const [view, setView] = useState<View>("split");
  const [zoom, setZoom] = useState<Zoom>("day");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("manual");

  const modeRef = useRef<Mode>("normal");
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
    () => (data ? visibleTasks(data.tasks, bySchedule, filter, sort) : []),
    [data, bySchedule, filter, sort],
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
      const next = await api.getState();
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
    const read = () => void api.getPeers().then(setPeers).catch(() => undefined);
    read();
    const timer = setInterval(read, PEERS_MS);
    return () => clearInterval(timer);
  }, []);

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

  /** Run ops, record them for undo, and refresh from the response. */
  const run = useCallback(
    async (ops: Op[], undo: Op[], label: string): Promise<AppData | null> => {
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
    [load],
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
   * Create a task and hand back its server-assigned id.
   *
   * The id is discovered by diffing against the previous state rather
   * than minted here, so the manual `position` the server computes for
   * `after` stays authoritative.
   */
  const createTask = useCallback(
    async (title: string, after: string | null, label: string) => {
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
    [data],
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
    [createTask],
  );

  const undo = useCallback(async () => {
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
  }, [load]);

  const redo = useCallback(async () => {
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
  }, [load]);

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

  // ---- key handling -----------------------------------------------

  const onKey = (e: KeyboardEvent) => {
    // Read the ref, not the state: see enterMode.
    const activeMode = modeRef.current;
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

    const buf = pending + key;
    const match = /^([1-9]\d*)?(.*)$/.exec(buf);
    const count = match?.[1] ? Number(match[1]) : 1;
    const cmd = match?.[2] ?? "";

    e.preventDefault();

    if (cmd === "" || (cmd.length === 1 && PREFIXES.has(cmd))) {
      setPending(buf);
      return;
    }
    setPending("");
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
      case ">":
        patchAll(
          selection,
          (task) => ({ priority: Math.min(3, task.priority + 1) }),
          "priority",
        );
        break;
      case "<":
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
      case "zi":
        setZoom(
          ZOOM_CYCLE[
            Math.min(ZOOM_CYCLE.indexOf(zoom) + 1, ZOOM_CYCLE.length - 1)
          ],
        );
        break;
      case "zo":
        setZoom(ZOOM_CYCLE[Math.max(ZOOM_CYCLE.indexOf(zoom) - 1, 0)]);
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

  const onCmdKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      enterMode("normal");
      setCmdline("");
      setSearchTerm("");
      return;
    }
    if (mode === "command" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const step = e.key === "ArrowUp" ? -1 : 1;
      const next = Math.min(
        Math.max(historyAt.current + step, 0),
        history.current.length,
      );
      historyAt.current = next;
      setCmdline(history.current[next] ?? "");
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const line = cmdline;
    setCmdline("");
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
            paneRef={listPane}
            onScroll={syncScroll(listPane)}
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
          />
        )}
      </div>

      <StatusLine
        mode={mode}
        cmdline={cmdline}
        onCmdChange={(value) => {
          setCmdline(value);
          if (mode === "search") setSearchTerm(value);
        }}
        onCmdKey={onCmdKey}
        message={message}
        pending={pending}
        hint={MODE_HINT[mode]}
      />

      {showHelp && <Help onClose={() => setShowHelp(false)} />}
    </div>
  );
}
