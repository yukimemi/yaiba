import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type PeersInfo, type ProjectsInfo } from "./api";
import {
  runCommand,
  type Columns,
  type DateField,
  type UiPatch,
  type View,
  type Zoom,
} from "./commands";
import {
  completionLine,
  startCompletion,
  stepCompletion,
  type Completion,
} from "./completion";
import { DATE_COLUMNS, dateLocked, dateValue } from "./dateColumns";
import { Gantt } from "./components/Gantt";
import { DatePicker, type Anchor } from "./components/DatePicker";
import { Help } from "./components/Help";
import { ProjectPalette } from "./components/ProjectPalette";
import { Hud } from "./components/Hud";
import { StatusLine, type Message } from "./components/StatusLine";
import { TaskList } from "./components/TaskList";
import { addDays, toISO } from "./dates";
import {
  dropOrder,
  effectiveParent,
  stepOrder,
  visibleTasks,
  type SortKey,
} from "./filter";
import { modeHint, type Mode } from "./mode";
import { t } from "./i18n";
import { applyLang, initialLang, type Lang } from "./lang";
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

/** Which side of its anchor a new row lands on. */
type Place = "after" | "before";

/**
 * The rows a command applies to: the block between the visual anchor and
 * the cursor, or just the cursor row when there is no anchor.
 *
 * Written as a plain function so the key handler can compute it from
 * live refs rather than the memo, which is a render behind.
 */
function selectionIn(
  visible: Task[],
  cursor: number,
  anchor: string | null,
): Task[] {
  const current = visible[cursor] ?? null;
  const at = anchor ? visible.findIndex((t) => t.id === anchor) : -1;
  if (at < 0) return current ? [current] : [];
  const [lo, hi] = at <= cursor ? [at, cursor] : [cursor, at];
  return visible.slice(lo, hi + 1);
}

const VIEW_CYCLE: View[] = ["split", "list", "gantt"];
const ZOOM_CYCLE: Zoom[] = ["month", "week", "day"];

export function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [mode, setMode] = useState<Mode>("normal");
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  /**
   * The same two, mirrored out of state for the reason `modeRef` and
   * `pendingRef` are: a burst of keys outruns React. `v j yy` typed at
   * speed had every handler after the first reading a render-old cursor
   * and a null anchor, so the yank took the row `v` was pressed on
   * instead of the block that was selected on screen.
   */
  const cursorRef = useRef<string | null>(null);
  const anchorRef = useRef<string | null>(null);
  const [linkAnchor, setLinkAnchor] = useState<string | null>(null);
  const [pending, setPending] = useState("");
  const [cmdline, setCmdline] = useState("");
  /** The open `<tab>` cycle, or null when nothing is being completed. */
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  /**
   * The row being renamed, and where the text caret opens.
   *
   * A row is a line, not a buffer with a column, so `i` and `a` have no
   * character position to insert before or after — the only thing left
   * of vim's distinction is which end of the title you land on.
   */
  const [editing, setEditing] = useState<{
    id: string;
    value: string;
    caret: "head" | "tail";
  } | null>(null);
  /** An unsaved row being typed. See `openNew`. */
  const [draft, setDraft] = useState<{
    /** The row it is placed next to. */
    anchor: string | null;
    /** Which side of the anchor it lands on — `O` is "before". */
    place: Place;
    /** The level it will land at — inherited from the row `o` was on. */
    parent: string | null;
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
  /** Which columns the list carries — `:dates` / `gd` swaps them. */
  const [columns, setColumns] = useState<Columns>("compact");
  /**
   * The date cell the calendar is open over.
   *
   * Held here rather than in the list because it owns the keyboard while
   * it is up, the same way the project palette does — and because the
   * panel is `position: fixed`, so it has to be rendered outside a pane
   * that scrolls and clips.
   */
  const [picking, setPicking] = useState<{
    id: string;
    field: DateField;
    anchor: Anchor;
  } | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("manual");
  const [theme, setTheme] = useState<Theme>(initialTheme);
  /** The language the weekday names are written in — nothing else. */
  const [lang, setLang] = useState<Lang>(initialLang);
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
  /**
   * The reference-date picker hanging off the HUD.
   *
   * State lives here rather than inside `Hud` because the global key
   * handler has no "focus is in a field" guard — it bails on explicit
   * flags instead (`showProjects`, the insert / command / search modes).
   * A date field owned entirely by the HUD would keep firing `j`, `x`
   * and `dd` at the task list while you typed into it.
   */
  const [showAsof, setShowAsof] = useState(false);

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

  /**
   * The block survives the `:` line, the way `'<,'>` does in vim.
   *
   * Typing `:` moves the mode to `command`, so gating on `visual` alone
   * collapsed the selection to the cursor row the instant the colon was
   * pressed — silently, since the highlight went with it. Every
   * multi-row command was affected (`:tag`, `:prio`, `:delete`), which
   * is why `patchSelection` builds a `label · N` message no `:` command
   * could ever produce, and why the submit handler used to end with a
   * `mode === "visual"` branch that could never be reached from a
   * command line.
   *
   * The anchor, not the mode, is what says a block is being addressed,
   * so `command` keeps reading it. That makes a *stale* anchor load-
   * bearing where it used to be inert: leaving one behind means the next
   * unrelated `:` rebuilds a block nobody selected. Both exits from the
   * command line drop it — submit does it before its early returns, esc
   * before its own.
   *
   * `search` is deliberately not on this list: `/` from visual does not
   * extend the block here, and pretending it does would be a second
   * change wearing this one's clothes.
   */
  const selecting = mode === "visual" || mode === "command";

  const selection = useMemo(
    () => selectionIn(visible, cursor, selecting ? anchorId : null),
    [selecting, anchorId, visible, cursor],
  );

  const selectedIds = useMemo(
    () => new Set(selecting ? selection.map((t) => t.id) : []),
    [selecting, selection],
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
    // The picker is an input like any other, even though the mode stays
    // normal behind it: a refresh mid-pick re-renders the cell the panel
    // is anchored to.
    if (picking) return;
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [mode, picking, load]);

  useEffect(() => {
    if (!cursorId && visible.length) putCursor(visible[0].id);
  }, [cursorId, visible]);

  /**
   * Drop an open picker whose row is gone — a peer's delete, a filter, a
   * project switch.
   *
   * Not cosmetic: the key handler stands down while a picker is up, so a
   * `picking` that outlived its row would leave the panel invisible and
   * every keystroke swallowed, with nothing on screen to escape from.
   */
  useEffect(() => {
    if (picking && !visible.some((t) => t.id === picking.id)) setPicking(null);
  }, [picking, visible]);

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
        putCursor(null);
        putAnchor(null);
        setPicking(null);
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
      .then(() => say(t("project · {name}", { name }), "ok"))
      .catch((e: Error) => failProject(e));
  };

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

  /**
   * Adopt a new project list *and* forget everything derived from the old
   * project, for the paths that also change which database is served.
   *
   * Creating a project and forgetting the one you were looking at both
   * land you somewhere else, so they owe the same reset a switch does: a
   * filter or a fold depth carried across would silently hide the new
   * project's tasks and read as the operation having lost them.
   */
  const adoptProjects = (info: ProjectsInfo, note: string) => {
    setProjects(info);
    setShowProjects(false);
    putCursor(null);
    putAnchor(null);
    setPicking(null);
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
        say(t("renamed {from} → {to}", { from, to }), "ok");
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

  /** Move the cursor, keeping the ref in lockstep. See `cursorRef`. */
  const putCursor = useCallback((id: string | null) => {
    cursorRef.current = id;
    setCursorId(id);
  }, []);

  /** Set the visual anchor, keeping the ref in lockstep. */
  const putAnchor = useCallback((id: string | null) => {
    anchorRef.current = id;
    setAnchorId(id);
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
   * Walk the reference date a day at a time, from the HUD's ◀ ▶.
   *
   * Landing on the real today has to send `null`, not the date itself:
   * the server marks any explicit date as `as_of`, and `as_of` is what
   * `liveOnly` refuses edits on. Stepping back to today and finding the
   * board still read-only — while the HUD says today — would be a trap
   * you could only escape by typing `:asof today`.
   *
   * Only that exact landing is special. The future is as reachable as
   * the past, because `:asof +3d` has always been: a reference date
   * ahead of now reads "if nothing moves, how far behind is this by
   * Friday", which is a fair question to ask of a plan. Both directions
   * are read-only and both are one click from coming back.
   *
   * Steps from `asofRef`, not from `data.today`. The ref moves the
   * moment you click; `data` only catches up when the reload resolves,
   * so a second click arriving before the fetch would read the date it
   * had *before* the first one and recompute the same day — two clicks
   * collapsing into one day of travel, exactly when you are holding the
   * arrow down to scrub.
   *
   * The ref is null at now, and `data.today` would be the reference date
   * rather than the real one anyway, so the base and the comparison both
   * fall back to the browser's date. The server this talks to runs on
   * this machine, so they share a clock.
   */
  const stepReference = useCallback(
    (days: number) => {
      const liveToday = toISO(new Date());
      const next = addDays(asofRef.current ?? liveToday, days);
      setReferenceDate(next === liveToday ? null : next);
    },
    [setReferenceDate],
  );

  /**
   * Mirror one pane's vertical scroll onto the other.
   *
   * The two panes render the same rows at the same height, so they only
   * stay aligned if they scroll together — otherwise row 20's bar sits
   * next to row 8's title. The flag breaks the feedback loop where each
   * scroll triggers the other's handler.
   *
   * The assignment is clamped to what the *target* can actually reach,
   * and the source is pulled back to match. A pane that is asked for a
   * `scrollTop` past its own end silently stops there and then holds
   * still while the other one keeps moving — which reads as the list
   * scrolling on its own with the gantt stuck beside it, and is worse
   * than a few pixels of unreachable tail. The panes carry the same
   * trailing space by CSS (`--pane-tail`), so what is left here is the
   * gantt's horizontal scrollbar eating into its visible height.
   */
  const syncScroll = useCallback(
    (from: React.RefObject<HTMLDivElement | null>) => () => {
      const source = from.current;
      const target = (from === listPane ? ganttPane : listPane).current;
      if (!source || !target || syncingScroll.current) return;
      syncingScroll.current = true;
      const top = Math.min(
        source.scrollTop,
        target.scrollHeight - target.clientHeight,
      );
      if (target.scrollTop !== top) target.scrollTop = top;
      if (source.scrollTop !== top) source.scrollTop = top;
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
    say(t("viewing the past — :asof today to make changes"), "error");
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
        say(t("nothing above to nest under"), "error");
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
        say(t("already at the top level"), "error");
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
   *
   * `known` exists because that diff is against `data`, which is a
   * render-old snapshot: a caller creating several rows in one pass
   * would rediscover its *first* row every time, and anchoring each row
   * on that one pastes a block back to front. Such a caller keeps its
   * own set and adds each id as it lands.
   */
  const createTask = useCallback(
    async (
      title: string,
      at: { anchor: string | null; place: Place; parent: string | null },
      label: string,
      known?: Set<string>,
    ) => {
      if (!liveOnly()) return null;
      const { anchor, place, parent } = at;
      const seen = known ?? new Set((data?.tasks ?? []).map((t) => t.id));
      try {
        const next = await api.createTask({
          title,
          parent,
          after: place === "after" ? anchor : null,
          before: place === "before" ? anchor : null,
        });
        setData(next);
        const created = next.tasks.find((t) => !seen.has(t.id));
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
  const openNew = useCallback(
    (anchor: string | null, place: Place, parent: string | null) => {
      setDraft({ anchor, place, parent, value: "" });
      enterMode("insert");
    },
    [],
  );

  const commitDraft = useCallback(
    async (openNext: boolean) => {
      const pending = draft;
      setDraft(null);
      enterMode("normal");
      if (!pending) return;

      const title = pending.value.trim();
      // An empty row is a cancelled thought, not a task.
      if (!title) return;
      const created = await createTask(
        title,
        {
          anchor: pending.anchor,
          place: pending.place,
          parent: pending.parent,
        },
        "new task",
      );
      if (created) putCursor(created.id);
      if (openNext) {
        // Same level again: <cr> continues the list you are writing, and
        // dropping back to the root mid-list would be the surprise. It
        // always continues *downward*, even out of an `O` — the row just
        // committed is the one the next belongs under.
        setDraft({
          anchor: created?.id ?? pending.anchor,
          place: created ? "after" : pending.place,
          parent: pending.parent,
          value: "",
        });
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
      putCursor(visible[clamped].id);
    },
    [visible],
  );

  /**
   * Move the cursor row `delta` rows up or down the list it is drawn
   * in, subtree in tow, taking the level of wherever it lands.
   *
   * Sibling-only movement stopped dead at the ends of a parent, so
   * carrying a row past one meant `<<`, `J`, `>>` — the level fixed up
   * by hand around every crossing. A row now leaves and enters parents
   * on its own, which is what the key looks like it does. See
   * `stepOrder`: the level only ever changes by the one step being
   * taken, so `K` puts back exactly what `J` moved, and the screen's
   * own state — what is folded, what is focused — is what stops a row
   * from moving somewhere it could not be seen afterwards.
   */
  const moveRow = useCallback(
    (row: Task | null, delta: number) => {
      if (!row || !data) return;
      if (sort !== "manual") {
        say(t("rows only move in manual order — :sort manual"), "error");
        return;
      }
      if (filter) {
        say(t("clear the filter before moving rows — :f"), "error");
        return;
      }
      // The focused row's own siblings are off screen, so moving it
      // would be a move nobody can see happen.
      if (focus && row.id === focus) {
        say(t("this row is the focus — zF to come back, then move it"), "error");
        return;
      }
      // A row counts as open when a child of it is on screen: that is
      // the same folding state the list draws, collapsed rows and
      // `foldLevel` alike, without either having to be passed in.
      // `effectiveParent` against the drawn set is the same rule the
      // tree walk applies, one list narrower — a parent that is not
      // drawn is not a parent anything can be filed under here.
      const drawn = new Set(visible.map((task) => task.id));
      const open = new Set<string>();
      for (const task of visible) {
        const parent = effectiveParent(task, drawn);
        if (parent) open.add(parent);
      }
      const ids = data.tasks.map((task) => task.id);
      const next = stepOrder(data.tasks, row.id, delta, { open, bound: focus });
      // Staying silent is indistinguishable from a move that did
      // nothing, so the one wall left says so.
      if (!next) {
        // Two whole sentences rather than a translated noun dropped into
        // one: "first" and "last" inflect differently in the two
        // languages, and a catalogue that has to translate a fragment
        // out of context is where the wrong word gets picked.
        say(
          delta > 0 ? t("already the last row") : t("already the first row"),
          "error",
        );
        return;
      }

      const ops: Op[] = [];
      const undoOps: Op[] = [];
      // Re-parent first, so the reorder is stamped onto the tree the
      // move asked for rather than the one it left.
      if (next.parent !== (row.parent ?? null)) {
        ops.push({ kind: "patch", id: row.id, patch: { parent: next.parent } });
        undoOps.push({
          kind: "patch",
          id: row.id,
          patch: { parent: row.parent },
        });
      }
      ops.push({ kind: "reorder", ids: next.ids });
      undoOps.push({ kind: "reorder", ids });
      void run(ops, undoOps, "move");
    },
    [data, visible, sort, filter, focus, run],
  );

  const deleteSelection = useCallback(
    (tasks: Task[]) => {
      if (!tasks.length || !data) return;
      const at = visible.findIndex((t) => t.id === cursorRef.current);
      const below =
        visible[
          Math.min((at >= 0 ? at : 0) + tasks.length, visible.length - 1)
        ];
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
      putAnchor(null);
      if (below && !tasks.some((t) => t.id === below.id)) putCursor(below.id);
    },
    [data, visible, run],
  );

  /**
   * Paste the register next to `at`, with its root rows at `parent`'s
   * level.
   *
   * The register is a block in the order it was drawn, so the copies
   * keep the shape it had: a row whose parent came along in the same
   * yank is re-parented onto that parent's *copy*, and only the rows
   * whose parent stayed behind land at the paste level. Flattening the
   * block instead threw away the breakdown that made it worth yanking.
   */
  const paste = useCallback(
    async (at: string | null, place: Place, parent: string | null) => {
      if (!liveOnly()) return;
      const block = register.current;
      if (!block.length) {
        say(t("nothing yanked"), "error");
        return;
      }
      // Kept across the loop because `createTask` diffs against a
      // render-old `data` — see its `known` parameter.
      const seen = new Set((data?.tasks ?? []).map((t) => t.id));
      const yanked = new Set(block.map((t) => t.id));
      /** Yanked id → the copy of it, for re-parenting the rows below. */
      const copies = new Map<string, string>();
      // One gesture is one undo: `createTask` files a step per row, and
      // four presses of `u` to take back one `p` is not an undo.
      const filedBefore = undoStack.current.length;

      let anchor = at;
      // Only the first row lands on the requested side; the rest follow
      // it, so a `P` of three keeps the register's own order.
      let side = place;
      let first: string | null = null;
      for (const task of block) {
        const under =
          task.parent && yanked.has(task.parent)
            ? (copies.get(task.parent) ?? parent)
            : parent;
        const created = await createTask(
          task.title,
          { anchor, place: side, parent: under },
          "paste",
          seen,
        );
        if (!created) break;
        seen.add(created.id);
        copies.set(task.id, created.id);
        first ??= created.id;
        anchor = created.id;
        side = "after";
        await api
          .patchTask(created.id, {
            notes: task.notes,
            assignee: task.assignee,
            priority: task.priority,
            start: task.start,
            duration_days: task.duration_days,
            due: task.due,
            tags: task.tags,
          })
          .then(setData)
          .catch(() => undefined);
      }

      const filed = undoStack.current.splice(filedBefore);
      if (filed.length > 1) {
        undoStack.current.push({
          redo: filed.flatMap((step) => step.redo),
          // Newest first, so a parent's copy outlives its children's.
          undo: filed.flatMap((step) => step.undo).reverse(),
          label: `paste ${filed.length}`,
        });
      } else if (filed.length) {
        undoStack.current.push(filed[0]);
      }

      // The head of what was pasted, the way a linewise `p` in vim
      // leaves the cursor on the first line it put down.
      if (first) putCursor(first);
      say(t("pasted {n}", { n: filed.length }), "ok");
    },
    [createTask, data, liveOnly],
  );

  const undo = useCallback(async () => {
    if (!liveOnly()) return;
    const step = undoStack.current.pop();
    if (!step) {
      say(t("already at the oldest change"));
      return;
    }
    try {
      setData(await applyOps(step.undo));
      redoStack.current.push(step);
      say(t("undo: {label}", { label: step.label }), "ok");
    } catch (e) {
      setMessage({ text: (e as Error).message, kind: "error" });
      void load();
    }
  }, [load, liveOnly]);

  const redo = useCallback(async () => {
    if (!liveOnly()) return;
    const step = redoStack.current.pop();
    if (!step) {
      say(t("already at the newest change"));
      return;
    }
    try {
      setData(await applyOps(step.redo));
      undoStack.current.push(step);
      say(t("redo: {label}", { label: step.label }), "ok");
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
          putCursor(task.id);
          return;
        }
      }
      say(t("pattern not found: {q}", { q: term }), "error");
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
        say(next === "light" ? t("office mode") : t("neon mode"));
        return next;
      });
    }
    if (ui.lang) {
      setLang((prev) => {
        const next = ui.lang === "toggle" ? (prev === "en" ? "ja" : "en") : ui.lang!;
        applyLang(next);
        // The one line that cannot come out of the catalogue: it is
        // said in the language just switched *to*, so whichever way you
        // flipped it the confirmation is readable.
        say(next === "ja" ? "日本語で表示します" : "now in English");
        return next;
      });
    }
    if (ui.columns) {
      setColumns((prev) => {
        const next =
          ui.columns === "toggle"
            ? prev === "dates"
              ? "compact"
              : "dates"
            : ui.columns!;
        say(
          next === "dates"
            ? t("dates — click a cell to pick one")
            : t("compact columns"),
        );
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
      say(t("close the tab to quit — the server keeps running"), "info");
    }
  }, []);

  const commitLink = useCallback(
    (row: Task | null, remove: boolean) => {
      if (!linkAnchor || !row || !data) return;
      if (row.id === linkAnchor) {
        say(t("a task can't depend on itself"), "error");
        return;
      }
      // The anchor is the task that waits; the row you land on is what
      // it waits for.
      const dep = { from: row.id, to: linkAnchor };
      const exists = data.deps.some(
        (d) => d.from === dep.from && d.to === dep.to,
      );
      if (remove && !exists) {
        say(t("no dependency between those two"), "error");
        return;
      }
      if (!remove && exists) {
        say(t("already linked"), "error");
        return;
      }
      void run(
        [remove ? { kind: "removeDep", dep } : { kind: "addDep", dep }],
        [remove ? { kind: "addDep", dep } : { kind: "removeDep", dep }],
        remove ? "unlink" : "link",
      );
      enterMode("normal");
      setLinkAnchor(null);
      putCursor(linkAnchor);
    },
    [linkAnchor, data, run],
  );

  // ---- mouse ------------------------------------------------------
  //
  // Every one of these maps onto a key: clicking a row is `j`/`k` to it,
  // the checkbox is `x`, the marker is `za`, a double-click is `a`, and
  // dragging a row is `J`/`K`. Sharing the same actions keeps the two
  // input methods from drifting apart.

  const onPick = useCallback((id: string) => putCursor(id), []);

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
      putCursor(id);
      setEditing({ id, value: task.title, caret: "tail" });
      enterMode("insert");
    },
    [visible, enterMode],
  );

  /**
   * Drop `dragged` into the slot `target` occupies — its level as well
   * as its place, subtree in tow.
   *
   * Splicing the flat `position` list, which is what this did, moves a
   * nested row past somebody else's child and leaves the drawn order
   * exactly as it was: the drag appeared to do nothing at all. Where you
   * dropped it is the only statement of intent a drag makes, so the row
   * takes the target's slot among the target's siblings, which for a
   * cross-level drop means changing its parent too.
   */
  const onDropRow = useCallback(
    (draggedId: string, targetId: string) => {
      if (!data) return;
      if (sort !== "manual") {
        say(t("rows only move in manual order — :sort manual"), "error");
        return;
      }
      const dragged = data.tasks.find((t) => t.id === draggedId);
      if (!dragged) return;
      const dropped = dropOrder(data.tasks, draggedId, targetId);
      if (!dropped) {
        say(t("a row cannot be dropped inside itself"), "error");
        return;
      }

      const ops: Op[] = [];
      const undo: Op[] = [];
      // Re-parent first, so the reorder that follows is stamped onto the
      // tree the drop asked for rather than the one it replaced.
      if (dropped.parent !== (dragged.parent ?? null)) {
        ops.push({
          kind: "patch",
          id: draggedId,
          patch: { parent: dropped.parent },
        });
        undo.push({
          kind: "patch",
          id: draggedId,
          patch: { parent: dragged.parent },
        });
      }
      ops.push({ kind: "reorder", ids: dropped.ids });
      undo.push({ kind: "reorder", ids: data.tasks.map((t) => t.id) });
      void run(ops, undo, "move");
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
        say(t("already linked"), "error");
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

  /**
   * Open the calendar on one of the cursor row's dates, from the
   * keyboard.
   *
   * Anchored on whatever is actually on screen: the cell when the date
   * columns are showing, the cursor row when they are not, and the
   * cursor's bar in the gantt-only view, where the list is unmounted
   * entirely. The alternative — refusing until `:dates` is on, or
   * turning it on for you — makes a display mode a precondition for an
   * edit, and the columns are a way to *read* the dates, not the only
   * place they exist. The same reasoning covers `tab`: a view is a
   * choice about what to look at, not about what can be edited.
   *
   * Reaching into the DOM for the box is the trade the gantt already
   * makes for hit-testing: the geometry is the browser's, and mirroring
   * it into state would only give us a second copy to keep in step.
   */
  const openDate = useCallback(
    (row: Task | null, field: DateField) => {
      if (!row) {
        say(t("no task under the cursor"), "error");
        return;
      }
      // The same refusal the cell renders as plain text, said out loud —
      // from the keyboard there is no shape to notice instead.
      const locked = dateLocked(field, bySchedule.get(row.id));
      if (locked) {
        say(t(locked), "error");
        return;
      }
      const box = (
        document.querySelector(`[data-date-cell="${row.id}:${field}"]`) ??
        document.querySelector(".row--cursor") ??
        // Gantt-only: the bar *is* where that task lives on screen. It
        // can be scrolled out of view horizontally, which the panel's
        // own clamp then pulls back on screen.
        document.querySelector(
          `.gantt__row[data-task-id="${row.id}"] .gantt__bar`,
        )
      )?.getBoundingClientRect();
      setPicking({
        id: row.id,
        field,
        // Nothing on screen to hang it off — no rows at all. The panel
        // still has to appear somewhere it can be read and dismissed.
        anchor: box
          ? { left: box.left, top: box.top, bottom: box.bottom }
          : { left: 40, top: 60, bottom: 60 },
      });
    },
    [bySchedule],
  );

  /**
   * Commit a date picked out of the calendar.
   *
   * By running the command the keyboard would have run, not by patching
   * the field: `:end` still turns a date into a duration, `:astart`
   * still refuses a span that finishes before it starts, and a summary
   * is still refused. A second implementation here would be the one
   * that is wrong after the next change to either.
   */
  const commitDate = useCallback(
    (id: string, field: DateField, iso: string | null) => {
      setPicking(null);
      if (!data) return;
      const task = visible.find((t) => t.id === id);
      if (!task) return;
      const result = runCommand(`${field} ${iso ?? "none"}`, {
        data,
        visible,
        current: task,
        // A click names one row, so it edits that row — even in visual
        // mode, where the same command from the keyboard takes the block.
        selection: [task],
        projects: projects.projects.map((p) => p.name),
      });
      if (!result) return;
      if (result.error) {
        say(result.error, "error");
        return;
      }
      if (result.ops) {
        void run(result.ops, result.undoOps ?? [], result.label ?? field);
      }
      if (result.message) say(result.message, "ok");
    },
    [data, visible, projects, run],
  );

  // ---- key handling -----------------------------------------------

  const onKey = (e: KeyboardEvent) => {
    // Read the ref, not the state: see enterMode.
    const activeMode = modeRef.current;
    // The palette and the date picker each run their own input and own
    // every key while up, exactly as insert / command / search do.
    if (showProjects || picking) return;
    // Same bargain for the reference-date picker, which carries a date
    // field of its own. Escape is the one key it hands back, so the
    // popover closes the way every other overlay here does.
    if (showAsof) {
      if (e.key === "Escape") {
        setShowAsof(false);
        e.preventDefault();
      }
      return;
    }
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

    // Everything below acts on the row under the cursor, so it is read
    // from the refs rather than from the memos, which are a render
    // behind. `v` `j` `yy` typed as one burst is the case that made this
    // necessary: React had not re-rendered by the time `yy` ran, so the
    // yank saw a null anchor and took the single row `v` was pressed on
    // while the screen showed a block. Two `j`s in a row had the same
    // shape — both moved from the same starting index, so the second
    // went nowhere. These names shadow the memoised ones on purpose:
    // the body below is written against the live values.
    const cursorAt = visible.findIndex((t) => t.id === cursorRef.current);
    const cursor = cursorAt >= 0 ? cursorAt : 0;
    const current: Task | null = visible[cursor] ?? null;
    const selection = selectionIn(
      visible,
      cursor,
      activeMode === "visual" ? anchorRef.current : null,
    );
    // The parent a row opened here inherits. `o` on a level-3 row means
    // "another one of these", not "back to the root three levels up".
    // A parent whose task is gone (a peer deleted it mid-merge) reads as
    // the root, which is where the list already draws the cursor row —
    // hence `effectiveParent`, the rule the tree walk itself applies.
    const cursorParent =
      current && data
        ? effectiveParent(current, new Set(data.tasks.map((t) => t.id)))
        : null;

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
        putAnchor(null);
        setLinkAnchor(null);
        break;
      case "v":
        if (activeMode === "visual") {
          enterMode("normal");
          putAnchor(null);
        } else if (current) {
          enterMode("visual");
          putAnchor(current.id);
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
        openNew(current?.id ?? null, "after", cursorParent);
        break;
      case "O":
        // Anchored on the cursor row, not on the row above it: there may
        // not be one, and `after: null` means "append to the end of the
        // store" — the opposite of what `O` says.
        openNew(current?.id ?? null, "before", cursorParent);
        break;
      case "i":
      case "I":
      case "a":
      case "A":
      case "cc":
        if (current) {
          // `cc` changes the line rather than entering it, so it opens
          // empty. Backing out costs nothing: `finishEdit` refuses a
          // blank title, so <esc> *and* <cr> both leave the old one.
          const clear = cmd === "cc";
          setEditing({
            id: current.id,
            value: clear ? "" : current.title,
            caret: cmd === "i" || cmd === "I" ? "head" : "tail",
          });
          enterMode("insert");
        }
        break;
      // `c` is change, and `cc` already changes the title — these change
      // the other four things a row holds. The letters follow the column
      // headings: start, end, and the two actuals under `a`.
      case "cs":
        openDate(current, "start");
        break;
      case "ce":
        openDate(current, "end");
        break;
      case "ca":
        openDate(current, "astart");
        break;
      case "cA":
        openDate(current, "aend");
        break;
      case "<space>":
      case "x":
        toggleDone(selection);
        if (activeMode === "visual") {
          enterMode("normal");
          putAnchor(null);
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
        say(t("yanked {n}", { n: selection.length }), "ok");
        if (activeMode === "visual") {
          enterMode("normal");
          putAnchor(null);
        }
        break;
      case "p":
        void paste(current?.id ?? null, "after", cursorParent);
        break;
      case "P":
        void paste(current?.id ?? null, "before", cursorParent);
        break;
      case "J":
        moveRow(current, count);
        break;
      case "K":
        moveRow(current, -count);
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
          say(t("pick what this task waits for — ⏎ to confirm"));
        }
        break;
      case "X":
        if (current) {
          setLinkAnchor(current.id);
          enterMode("unlink");
          say(t("pick the dependency to cut — ⏎ to confirm"));
        }
        break;
      case "<cr>":
        if (activeMode === "link") commitLink(current, false);
        else if (activeMode === "unlink") commitLink(current, true);
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
          say(t("focused “{title}” — zF to come back", { title: current.title }));
        }
        break;
      case "zF":
        setFocus(null);
        say(t("showing everything"));
        break;

      // ---- the breakdown itself
      case ">>":
        indent(selection);
        break;
      case "<<":
        outdent(selection);
        break;

      case "gd":
        applyUi({ columns: "toggle" });
        break;

      case "gt":
        applyUi({ theme: "toggle" });
        break;

      case "R":
        void load();
        say(t("reloaded"), "ok");
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
      // A cancelled command leaves no block armed. The submit path
      // clears the anchor for the same reason; without this, backing
      // out of `:` would keep one alive with nothing on screen saying
      // so — see `selecting`.
      putAnchor(null);
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
    // Submitting the line ends the block, whatever the command does with
    // it — including nothing. Clearing this at the *end* of the handler
    // instead left a live anchor behind every early return (an empty
    // line, a refusal, no data yet), and since `selecting` now reads the
    // anchor in `command` mode, the next unrelated `:` would silently
    // rebuild a block from that stale anchor to wherever the cursor had
    // moved. `selection` below is the memo captured at render, so
    // dropping the anchor here cannot shrink the block this command is
    // about to act on.
    putAnchor(null);

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
        say(t("sync is off — started with --no-sync"), "error");
      } else {
        // Copying is best-effort: it needs a secure context, which
        // plain http://localhost happens to qualify as, but a LAN
        // address would not.
        const ticket = peers.ticket;
        void navigator.clipboard
          ?.writeText(ticket)
          .then(() => say(t("ticket copied · {ticket}", { ticket }), "ok"))
          .catch(() => say(peers.ticket ?? "", "ok"));
      }
    }
    if (result.peer?.join) {
      void api
        .joinPeer(result.peer.join)
        .then((info) => {
          setPeers(info);
          say(t("joined · {n} peer(s)", { n: info.peers.length }), "ok");
          void load();
        })
        .catch((e: Error) => say(e.message, "error"));
    }
    if (result.project?.pick) {
      // Opens however few projects there are. Switching is only one of the
      // things in here — create, rename and forget all live on the list
      // too, and refusing to open with a single project hid all three
      // behind commands you would have to already know about.
      setProjectError(null);
      setShowProjects(true);
    }
    if (result.project?.switch) switchTo(result.project.switch);
    if (result.project?.create) createProject(result.project.create);
    if (result.project?.forget) forgetProject(result.project.forget);
    if (result.project?.rename) renameProject(projects.active, result.project.rename);
    if (result.ops) {
      void run(result.ops, result.undoOps ?? [], result.label ?? line);
    }
    if (result.message) say(result.message, result.ops ? "ok" : "info");
  };

  // ---- render -----------------------------------------------------

  if (!data) {
    return (
      <div className="app">
        <p className="empty">connecting to the local replica…</p>
      </div>
    );
  }

  /** The level the unsaved row will land at, so it is drawn at it. */
  const draftLevel = draft?.parent
    ? (bySchedule.get(draft.parent)?.level ?? 0) + 1
    : 0;

  // Where the unsaved row sits in the visible list. Above its anchor for
  // `O`; for `o`, below it *and* below any of the anchor's subtree that
  // is deeper than the draft itself — the server orders by `position`
  // and the tree walk then groups those rows under the anchor, drawing
  // them above a sibling that follows it. Without that the preview sat
  // directly under the anchor and the committed row appeared below the
  // subtree, which reads as <cr> having moved it.
  const draftIndex = (() => {
    if (!draft) return -1;
    if (!draft.anchor) return 0;
    const at = visible.findIndex((t) => t.id === draft.anchor);
    if (at < 0) return 0;
    if (draft.place === "before") return at;
    let below = at + 1;
    while ((bySchedule.get(visible[below]?.id ?? "")?.level ?? -1) > draftLevel)
      below += 1;
    return below;
  })();

  // The window has to cover what *happened* as well as what is planned.
  // A backfilled `:astart` can predate every scheduled start — the plan
  // moves when a dependency slips, the record of the work does not — and
  // a rail left of `rangeStart` is drawn at a negative offset inside a
  // pane whose `scrollLeft` stops at 0: on screen for nobody, which is
  // the "stored but never displayed" bug these rails exist to end.
  // ISO dates compare lexicographically, so plain min/max is enough.
  const spanned = [
    data.schedule.start,
    data.schedule.end,
    data.today,
    ...data.tasks.flatMap((t) =>
      [t.actual_start, t.actual_end].filter((d): d is string => d !== null),
    ),
  ];
  const rangeStart = addDays(
    spanned.reduce((a, b) => (a < b ? a : b)),
    -3,
  );
  const rangeEnd = addDays(
    spanned.reduce((a, b) => (a > b ? a : b)),
    zoom === "day" ? 7 : 30,
  );

  // Both can go missing under an open picker — a peer's delete, or a
  // filter that no longer matches — and then there is no cell to float
  // over any more.
  const pickingTask = picking
    ? (visible.find((t) => t.id === picking.id) ?? null)
    : null;
  const pickingColumn = picking
    ? (DATE_COLUMNS.find((c) => c.field === picking.field) ?? null)
    : null;

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
        reference={data.today}
        isAsOf={data.as_of}
        asofOpen={showAsof}
        onToggleAsof={() => setShowAsof((open) => !open)}
        onCloseAsof={() => setShowAsof(false)}
        onStepAsof={stepReference}
        onSetAsof={setReferenceDate}
        foldLevel={foldLevel}
        theme={theme}
        project={projects.active}
        projectCount={projects.projects.length}
        onOpenProjects={() => {
          setProjectError(null);
          setShowProjects(true);
        }}
        onToggleTheme={() => applyUi({ theme: "toggle" })}
        lang={lang}
        onToggleLang={() => applyUi({ lang: "toggle" })}
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
            draftLevel={draftLevel}
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
              filter ? t("nothing matches this filter.") : t("no tasks yet.")
            }
            sort={sort}
            columns={columns}
            picking={picking}
            onOpenDate={(id, field, anchor) => setPicking({ id, field, anchor })}
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
            lang={lang}
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
        hint={modeHint(mode)}
      />

      {/* Keyed on the cell, because clicking straight from one open
          picker onto another cell never renders a null `picking`: a
          real mouse dispatches pointerdown and mousedown in one task,
          so the outside-click close and the new open batch into a
          single render. Unkeyed, React reuses the instance and its
          `cursor` — seeded once at mount — keeps showing the month you
          paged to for the *previous* cell. Synthetic clicks split the
          two events across tasks and hide this entirely. */}
      {picking && pickingTask && pickingColumn && (
        <DatePicker
          key={`${picking.id}:${picking.field}`}
          value={dateValue(
            pickingColumn.field,
            pickingTask,
            bySchedule.get(pickingTask.id),
          )}
          today={data.today}
          lang={lang}
          anchor={picking.anchor}
          label={t(pickingColumn.head)}
          hint={t(pickingColumn.title)}
          clearable={pickingColumn.clearable}
          onPick={(iso) => commitDate(pickingTask.id, pickingColumn.field, iso)}
          onClose={() => setPicking(null)}
        />
      )}

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
