import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type PeersInfo, type ProjectsInfo } from "./api";
import {
  assigneeNames,
  pinStartOps,
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
import { DATE_COLUMNS, dateHead, dateLocked, dateValue } from "./dateColumns";
import { DAY_W, Gantt } from "./components/Gantt";
import { DatePicker, type Anchor } from "./components/DatePicker";
import { Help } from "./components/Help";
import { ProjectPalette } from "./components/ProjectPalette";
import { Hud } from "./components/Hud";
import { OwnerPicker } from "./components/OwnerPicker";
import { RowMenu, type RowMenuAt } from "./components/RowMenu";
import { isCmdline, type MenuAction } from "./rowMenu";
import { SplitGrip } from "./components/SplitGrip";
import { StatusLine, type Message } from "./components/StatusLine";
import { Strikes } from "./components/Strikes";
import { TaskList } from "./components/TaskList";
import { addDays, diffDays, toISO } from "./dates";
import {
  BURST_MS,
  depKey,
  FLASH_MS,
  QUAKE_CLASSES,
  SEVER_MS,
  SLAIN_MS,
  type FlashKind,
} from "./flash";
import { DEFAULT_LAG } from "./types";
import {
  collapsedForDepth,
  dropOrder,
  effectiveParent,
  foldStep,
  stepOrder,
  visibleTasks,
  type SortKey,
} from "./filter";
import {
  cellColumns,
  actualsWriteFirst,
  cellClear,
  cellEdit,
  cellRead,
  cellSpan,
  cellStep,
  cellWriteLine,
  pastePlan,
  type CellBlock,
  type CellField,
  type EditKey,
} from "./cells";
import { modeHint, type Mode } from "./mode";
import { t } from "./i18n";
import { applyLang, initialLang, type Lang } from "./lang";
import { applySplit, clampSplit, initialSplit } from "./split";
import { applyTheme, initialTheme, type Theme } from "./theme";
import {
  initialViewState,
  saveViewState,
  type ProjectUiState,
} from "./uiState";
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
  /**
   * The stroke each task is playing, if any — see `flash.ts`.
   *
   * A map rather than the set of completed rows it started as, because
   * three events draw now and a row can be handed a second one while the
   * first is still on it (finish a task, delete it before the sweep is
   * over). Whoever wrote last owns the row.
   */
  const [flashes, setFlashes] = useState<Map<string, FlashKind>>(new Map());
  /**
   * Edges mid-sever, keyed by `depKey`.
   *
   * Separate from `flashes` because a dep is not a task and its key is a
   * pair; merging them would mean one map whose keys mean two things.
   */
  const [severing, setSevering] = useState<Set<string>>(new Set());
  /**
   * Bumped to replay the blade across the whole shell — a new node each
   * time, because an animation only restarts from a fresh one.
   */
  const [wipe, setWipe] = useState(0);
  /**
   * The screen's own answer to a stroke, in super mode — see `flash.ts`.
   *
   * Keyed like `wipe`, and for the same reason: a counter, because the
   * same kind twice in a row still has to draw twice. It is *rendered*
   * only in super mode rather than left to the stylesheet the way
   * `--glow` is, because an unstyled `<div>` inside `.app` is not
   * invisible — `.app` is a grid, and a fourth child would take a row of
   * it. The one place the mode reaches the render tree, and that is why.
   */
  const [burst, setBurst] = useState<{ kind: FlashKind; n: number } | null>(null);
  /**
   * The burst counter, in a ref as well as in the state.
   *
   * The timer that takes a burst down has to know *which* burst it was
   * cancelling, and reading `prev.n + 1` inside the updater does not
   * tell the timer anything — the number has to exist before the state
   * does.
   */
  const burstSeq = useRef(0);
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

  /**
   * The global half of the persisted UI state (see uiState.ts), read once
   * at mount so a reload reopens with the view, zoom, columns and sort it
   * was closed with. Saved by the effect further down on every change.
   */
  const [savedView] = useState(initialViewState);
  const [view, setView] = useState<View>(savedView.view);
  const [zoom, setZoom] = useState<Zoom>(savedView.zoom);
  /** Which columns the list carries — `:dates` / `gd` swaps them. */
  const [columns, setColumns] = useState<Columns>(savedView.columns);
  /**
   * Which cell of the cursor row `h` / `l` last walked to.
   *
   * Not persisted with the rest of the view state: where you were
   * standing on a row is a position mid-edit, not a way of looking at
   * the project, and a reload that put the cursor back on `ended` would
   * be restoring a keystroke rather than a view.
   *
   * Deliberately *not* reset when the cursor row changes — that is what
   * makes a column walkable straight down the page with `j`, which is
   * the whole point of #87.
   */
  const [cellRaw, setCellRaw] = useState<CellField>("title");
  /**
   * The same, mirrored out of state for the reason `cursorRef` is: a
   * burst of keys outruns React. Three `l` in one tick all read the same
   * render-old column and set it to the same neighbour, so the cursor
   * moved one cell and swallowed the other two — measured, not guessed,
   * against a burst of `j` in the same page, which walked all three rows
   * because it goes through `cursorRef`.
   */
  const cellRef = useRef<CellField>("title");
  /**
   * The column `v` was pressed in — the other corner of the selection.
   *
   * `anchorId` holds the row corner; this holds the column one, and the
   * two together are the rectangle. Mirrored into a ref for the reason
   * `anchorRef` is: `v l j y` is four keys typed as fast as any burst,
   * and a yank that read a render-old corner would take the wrong block
   * — the exact bug #75 was.
   */
  const [anchorCell, setAnchorCell] = useState<CellField | null>(null);
  const anchorCellRef = useRef<CellField | null>(null);
  /**
   * `V` rather than `v` — the selection spans every column, whatever the
   * cell cursor does.
   *
   * A separate flag rather than "the anchor is the first column and the
   * cursor the last", because that state is reachable by walking and
   * would then silently become a line select: `V` is a promise that the
   * whole row is taken, and `h` must not quietly break it.
   */
  const [visualLine, setVisualLine] = useState(false);
  const visualLineRef = useRef(false);
  const cellCols = useMemo(() => cellColumns(columns), [columns]);
  /**
   * The cell cursor clamped to a column that is actually drawn.
   *
   * Derived rather than reset by an effect on `columns`, so there is no
   * render in which the handler holds a column nothing is rendering —
   * the hazard #87 named, and the one `picking` already has a rule
   * about. Turning `gd` off leaves one column, so the clamp is what
   * silently parks the cursor back on the title; turning it on again
   * restores where you were, because `cellRaw` was never cleared.
   */
  const cell: CellField = cellCols.includes(cellRaw) ? cellRaw : "title";
  /**
   * Move the cell cursor, ref first — the only thing that writes either.
   *
   * `putCursor` for columns, and it exists for the same reason: the
   * handler must never read the column out of a render.
   */
  const putCell = useCallback((next: CellField) => {
    cellRef.current = next;
    setCellRaw(next);
  }, []);
  /** The column corner of the selection — `putAnchor` for cells. */
  const putAnchorCell = useCallback((next: CellField | null) => {
    anchorCellRef.current = next;
    setAnchorCell(next);
  }, []);
  const putVisualLine = useCallback((next: boolean) => {
    visualLineRef.current = next;
    setVisualLine(next);
  }, []);
  /**
   * The list's share of the split, as a percent.
   *
   * Held here only so `:split n` and the grip agree on a number and it
   * survives a reload; the *width* is a CSS variable that `applySplit`
   * writes, which is what lets a drag move the divider without a render.
   */
  const [listWidth, setListWidth] = useState(initialSplit);
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
  /**
   * The row whose owner panel is up.
   *
   * Its own state rather than a fifth `DateField`: that type indexes
   * `DATE_COLUMNS` and drives `commitDate`, and an owner is neither a
   * date nor one of those columns. Every lifecycle rule `picking` has
   * applies here too — polling stands down, the key handler stands down,
   * and it is dropped when its row leaves `visible`.
   */
  const [pickingOwner, setPickingOwner] = useState<{
    id: string;
    anchor: Anchor;
  } | null>(null);
  /** The row menu, and where the pointer asked for it. */
  const [rowMenu, setRowMenu] = useState<RowMenuAt | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>(savedView.sort);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  /** The language the weekday names are written in — nothing else. */
  const [lang, setLang] = useState<Lang>(initialLang);
  /**
   * Every folded summary — the whole of the folding state.
   *
   * `zM` / `zm` / `:level` write into this too, by expanding a depth into
   * the summaries that produce it. See `foldToDepth`.
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /**
   * The depth the last fold-to-level command asked for, remembered so
   * `zm` and `zr` have something to step from. Nothing renders from it —
   * that is `collapsed`'s job alone, which is the fix for the two-axis
   * conflict described on `ViewOptions.collapsed` — so it is a ref rather
   * than state, and a burst of `zr zr zr` reads its own last write
   * instead of a render-old one.
   *
   * A per-row `za` deliberately leaves it alone: `zr` after hand-folding
   * should still step from the last level you asked for rather than
   * becoming a dead key, which is the trap this whole change is about.
   */
  const foldLevelRef = useRef<number | null>(null);
  /**
   * Set once the active project's saved UI state has been applied (or
   * failed to load). Saves are gated on it: writing the mount-time
   * defaults over the saved blob before the GET answered would turn every
   * reload into a reset — the bug the whole mechanism exists to fix.
   */
  const uiLoadedRef = useRef(false);
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
  /** The shell, for the recoil super mode's typing puts on it. */
  const shellRef = useRef<HTMLDivElement>(null);
  /**
   * What the timeline is currently drawn against, for `T`.
   *
   * A ref rather than the values themselves: the window is computed near
   * the bottom of the render, *after* the early return for a state that
   * hasn't loaded yet, so a handler closing over it directly would throw
   * on any key pressed during the first paint. Mirroring is also what
   * every other cross-cutting value here does — see `cursorRef`.
   */
  const timeline = useRef<{
    rangeStart: string;
    today: string;
    dayW: number;
  } | null>(null);
  const syncingScroll = useRef(false);
  const undoStack = useRef<Step[]>([]);
  const redoStack = useRef<Step[]>([]);
  const register = useRef<Task[]>([]);
  /**
   * The other register: a rectangle of cell values.
   *
   * Kept apart from the row register because the two paste into
   * different worlds — rows create tasks, cells overwrite fields on
   * tasks that already exist — and a `p` that guessed which you meant
   * from the cursor would guess wrong on the row you were about to
   * duplicate.
   */
  const cellRegister = useRef<CellBlock | null>(null);
  /**
   * Which of the two `p` puts down: whichever was filled last.
   *
   * One paste key and two registers has to resolve somehow, and "the
   * thing you just yanked" is the only rule nobody has to remember.
   * `yy` / `Y` set this to rows, `y` sets it to cells.
   */
  const lastYank = useRef<"rows" | "cells">("rows");
  const history = useRef<string[]>([]);
  const historyAt = useRef(0);
  /**
   * The command layer, published for callers that are not a keyboard.
   *
   * Declared here rather than beside `runKey` because the row menu's
   * handler is defined long before it and closes over this binding; a
   * ref filled in later is the same trick `keyRef` uses, and keeps the
   * menu from re-subscribing on every render.
   */
  const runKeyRef = useRef<
    (cmd: string, count?: number, counted?: boolean) => void
  >(() => {});

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
            focus,
          })
        : [],
    [data, bySchedule, filter, sort, collapsed, focus],
  );

  /** The progress line is noise on an empty plan; show it once there is
   *  something to compare. */
  const showProgressLine = (data?.tasks.length ?? 0) > 0;

  /**
   * The vocabulary the owner panel offers — see `assigneeNames`.
   *
   * Up here with the other memos, and not beside the `pickingOwner` row it
   * feeds, because the render below returns early while `data` is null: a
   * hook after that point is skipped on the first render and called on the
   * second, which is React error #310 and takes the whole app down rather
   * than degrading. It cost this branch every one of its hand-verification
   * rounds — the app never mounted at all, and an empty `#root` reads
   * exactly like a page that was never given a chance to paint.
   */
  const ownerNames = useMemo(
    () => (data ? assigneeNames({ data, projects: [] }) : []),
    [data],
  );

  /** Deepest level present, so zr knows when it has fully unfolded. */
  const maxLevel = useMemo(
    () =>
      (data?.schedule.tasks ?? []).reduce((m, s) => Math.max(m, s.level), 0),
    [data],
  );

  /**
   * The depth the HUD reports, or null when nothing is folded.
   *
   * Read off the rows actually drawn, not off `foldLevel` — after `zM`
   * plus one `za` those two disagree, and the one worth showing is the
   * one describing the screen. Gated on `collapsed` being non-empty so a
   * filter that happens to match only shallow rows does not read as a
   * fold.
   */
  const visibleDepth = useMemo(() => {
    if (!collapsed.size) return null;
    return visible.reduce(
      (deepest, task) => Math.max(deepest, bySchedule.get(task.id)?.level ?? 0),
      0,
    );
  }, [collapsed, visible, bySchedule]);

  /**
   * Fold to a depth: remember it, and expand it into `collapsed`.
   *
   * `null` is "no depth asked for", which unfolds everything — the state
   * `zR` leaves behind. Everything else replaces `collapsed` outright
   * rather than merging, because a fold-to-level is a statement about the
   * whole tree; merging would leave rows open that the depth says to
   * close and make the second `zm` press behave differently from the
   * first.
   */
  const foldToDepth = useCallback(
    (depth: number | null) => {
      foldLevelRef.current = depth;
      setCollapsed(
        depth === null
          ? new Set<string>()
          : collapsedForDepth(data?.schedule.tasks ?? [], depth),
      );
    },
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
  /**
   * The columns the selection covers, for the list to draw.
   *
   * The render's own copy of what the key handler computes off the refs.
   * Null outside visual, and the full width under `V` — which is not a
   * rectangle six cells wide but the row itself, drawn edge to edge
   * because that is the unit `V` acts on. A selection that drew narrower
   * than it acts would be lying about what `y` and `d` will take.
   */
  const selectedCols = useMemo<CellField[] | null>(() => {
    if (!selecting) return null;
    if (visualLine) return cellCols;
    return cellSpan(anchorCell ?? cell, cell, cellCols);
  }, [selecting, visualLine, anchorCell, cell, cellCols]);

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

  /**
   * Apply the active project's saved UI state, field by field, so a blob
   * from another version only loses the fields it doesn't have.
   */
  const applyProjectUi = useCallback((ui: ProjectUiState) => {
    if (ui.filter !== undefined) setFilter(ui.filter);
    if (ui.collapsed) setCollapsed(new Set(ui.collapsed));
    if (ui.focus !== undefined) setFocus(ui.focus);
    if (ui.foldLevel !== undefined) foldLevelRef.current = ui.foldLevel;
  }, []);

  /**
   * Fetch and apply the active project's saved UI state, then open the
   * gate for saves. Called at mount and after every project switch —
   * anywhere the state on screen was just reset to the defaults.
   */
  const loadProjectUi = useCallback(async () => {
    try {
      applyProjectUi(await api.getUi());
    } catch {
      // A dropped connection or an older server keeps the defaults — the
      // state is a convenience, never a requirement for the app to work.
    }
    uiLoadedRef.current = true;
  }, [applyProjectUi]);

  useEffect(() => {
    void load();
    void loadProjectUi();
  }, [load, loadProjectUi]);

  // The global half of the persisted UI state — written on every change,
  // read once at mount (see `savedView`).
  useEffect(() => {
    saveViewState({ view, zoom, columns, sort });
  }, [view, zoom, columns, sort]);

  /**
   * A pass of the blade whenever the view changes — `<tab>`, `:view`,
   * `:split`. The panes below the HUD are replaced wholesale, and without
   * a stroke across the swap the new contents simply appear, which is
   * indistinguishable from a reload that lost your place.
   *
   * Keyed on the *previous* view rather than a "have I mounted yet" flag,
   * so the boot never fires it: at mount the two are equal, and they stay
   * equal under StrictMode's second run, where a one-shot flag would have
   * been spent by the first and let the wipe play over the boot sweep.
   * `:split 40` on an already-split screen changes only the width, and
   * correctly draws nothing.
   */
  const lastView = useRef(view);
  useEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    setWipe((n) => n + 1);
  }, [view]);

  /**
   * The per-project half, debounced: a burst of `zm`/`zr` is one write,
   * not one per key. Gated both at scheduling and inside the timer — a
   * write armed just before a project switch must not land this project's
   * state in the next one's database.
   */
  useEffect(() => {
    if (!uiLoadedRef.current) return;
    const timer = setTimeout(() => {
      if (!uiLoadedRef.current) return;
      void api
        .putUi({
          collapsed: [...collapsed],
          focus,
          filter,
          foldLevel: foldLevelRef.current,
        })
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [collapsed, focus, filter]);

  /**
   * Drop a focus whose root is gone — a peer's delete since the state was
   * saved. Showing the subtree of a task that no longer exists means
   * showing nothing, which reads as the app having lost the plan.
   */
  useEffect(() => {
    if (focus && data && !data.tasks.some((t) => t.id === focus)) setFocus(null);
  }, [focus, data]);

  // Peers merge in the background, so the local view has to re-read.
  // Pausing while typing keeps a refresh from yanking the row you're
  // editing out from under the caret.
  useEffect(() => {
    if (mode !== "normal" && mode !== "visual") return;
    // The picker is an input like any other, even though the mode stays
    // normal behind it: a refresh mid-pick re-renders the cell the panel
    // is anchored to.
    if (picking || pickingOwner) return;
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [mode, picking, pickingOwner, load]);

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
    if (pickingOwner && !visible.some((t) => t.id === pickingOwner.id)) {
      setPickingOwner(null);
    }
  }, [picking, pickingOwner, visible]);

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
    // Close the save gate before the server moves: a write racing the
    // switch would land this project's state in the next one's database.
    uiLoadedRef.current = false;
    void api
      .switchProject(name)
      .then(async (info) => {
        setProjects(info);
        putCursor(null);
        putAnchor(null);
        setPicking(null);
        setFocus(null);
        // The folded set names rows that do not exist in the project being
        // switched to, and the remembered depth was measured against a
        // different tree — the same failure the filter reset above exists
        // to prevent. Set directly rather than through `foldToDepth`,
        // which would read the *outgoing* project's schedule.
        foldLevelRef.current = null;
        setCollapsed(new Set());
        setFilter("");
        await load();
        // The incoming project's own saved state replaces those defaults,
        // and reopens the save gate once it is applied.
        await loadProjectUi();
        // After the load, not before it: the stroke marks the moment the
        // other project's tasks are actually on screen. Started at the
        // click it would have swept a screen still showing the old one.
        setWipe((n) => n + 1);
        say(t("project · {name}", { name }), "ok");
      })
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
    // Same reasoning as `switchTo`: a folded set from another project
    // names rows that are not here.
    foldLevelRef.current = null;
    setCollapsed(new Set());
    setFilter("");
    uiLoadedRef.current = false;
    void load()
      .then(() => loadProjectUi())
      .then(() => say(note, "ok"));
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

  /** Drop the whole selection — both corners and the line flag. */
  const leaveVisual = useCallback(() => {
    if (modeRef.current !== "visual") return;
    enterMode("normal");
    putAnchor(null);
    putAnchorCell(null);
    putVisualLine(false);
  }, [enterMode, putAnchor, putAnchorCell, putVisualLine]);

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
   * Bring the reference line into view without moving the cursor.
   *
   * The timeline's left edge is the earliest thing anyone planned, so on
   * a project with any history it opens months behind the work in
   * flight. The only other thing that scrolls it horizontally is the
   * cursor-follow in `Gantt`, which answers "where is *this row*" — a
   * fair question, and not this one. Nothing here changes the cursor, so
   * the follow effect has no reason to fire and undo it; the next `j`
   * will scroll away again, which is the app's usual bargain.
   *
   * A third of the way in rather than flush left: the line is worth
   * reading against what came before it, not just what comes after.
   */
  const scrollToReference = useCallback(() => {
    const pane = ganttPane.current;
    const drawn = timeline.current;
    if (!pane || !drawn) {
      say(t("no timeline in this view — <tab>"), "error");
      return;
    }
    const line = diffDays(drawn.rangeStart, drawn.today) * drawn.dayW;
    // The browser clamps a scrollLeft past the end, so only the near
    // edge needs guarding.
    pane.scrollTo({ left: Math.max(line - pane.clientWidth / 3, 0) });
  }, []);

  /**
   * Draw one of the blade's strokes across some rows — see `flash.ts`.
   *
   * Defined up here rather than with the actions below because
   * `createTask` calls it, and a `const` read before its initialiser has
   * run is a ReferenceError rather than a lint warning.
   *
   * Each id is cleared on its own timer rather than the whole map being
   * emptied, which is what the completion flash used to do while it was
   * the only one. Two of them can overlap now — deleting a row mid-sweep,
   * pasting a block over one — and a shared timer would wipe the second
   * stroke off part-played. The `=== kind` guard is the other half: a row
   * handed a second stroke keeps it when the first one's timer lands.
   */
  const flash = useCallback((ids: string[], kind: FlashKind) => {
    if (!ids.length) return;
    // One burst per gesture, not per row: completing a block of five is
    // one thing that happened, and five overlaid copies of one overlay
    // would only be a brighter one anyway.
    //
    // Counted in every theme rather than only in super, deliberately.
    // It lands in the same batch as the `setFlashes` below, so it costs
    // no render that was not already happening, and the alternative is
    // threading the theme into a callback that closes over nothing on
    // purpose — a ref to save one integer. What the theme decides is
    // whether the burst is *rendered*, which is where that question
    // belongs.
    //
    // And it is taken down again on its own timer, because "rendered
    // only in super mode" cuts both ways: a burst left standing is one
    // that plays afresh the moment somebody presses `gs`, for a gesture
    // that finished minutes ago. The quake class rides the same state
    // and would sit on the shell just as long.
    //
    // The guard is the sequence number rather than the kind: two `cut`s
    // in a row are two bursts, and a kind-matching guard would let the
    // first one's timer take the second one down mid-play.
    const n = (burstSeq.current += 1);
    setBurst({ kind, n });
    window.setTimeout(() => {
      setBurst((prev) => (prev?.n === n ? null : prev));
    }, BURST_MS[kind]);
    setFlashes((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, kind);
      return next;
    });
    window.setTimeout(() => {
      setFlashes((prev) => {
        const next = new Map(prev);
        for (const id of ids) if (next.get(id) === kind) next.delete(id);
        return next;
      });
    }, FLASH_MS[kind]);
  }, []);

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
          // The draw. Here rather than in `commitDraft` so a row born
          // from a paste gets it too — the register lands through this
          // same call, one row at a time. A restore does not, and that
          // is the line: `u` puts back a task that already existed.
          flash([created.id], "born");
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
    [data, liveOnly, flash],
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

  const toggleDone = useCallback(
    (tasks: Task[]) => {
      if (!tasks.length) return;
      // A mixed selection completes rather than toggling each row —
      // "finish these" is the intent behind pressing x on a block.
      const allDone = tasks.every((t) => t.status === "done");
      if (!allDone) flash(tasks.map((t) => t.id), "cut");
      patchAll(
        tasks,
        () =>
          allDone
            ? { status: "todo", progress: 0 }
            : { status: "done", progress: 100 },
        allDone ? "reopen" : "done",
      );
    },
    [patchAll, flash],
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
      // Asked here as well as inside `run`, because the wait below means
      // a refusal would otherwise arrive after the rows had visibly been
      // struck — the report has to come before the stroke, not after it.
      if (!tasks.length || !data || !liveOnly()) return;
      const at = visible.findIndex((t) => t.id === cursorRef.current);
      const below =
        visible[
          Math.min((at >= 0 ? at : 0) + tasks.length, visible.length - 1)
        ];
      register.current = tasks;
      // Both lists are built now, against the `data` the rows were
      // chosen from, because the run below happens after a wait.
      const ops: Op[] = tasks.map((t) => ({ kind: "delete", id: t.id }));
      const undoOps: Op[] = tasks.map((t) => ({
        kind: "restore",
        task: t,
        deps: data.deps.filter((d) => d.from === t.id || d.to === t.id),
      }));
      /*
       * The stroke needs the row to still be there to cross, so the
       * delete is filed `SLAIN_MS` late — the one place in the app where
       * an effect costs a write any delay at all, and why that number is
       * the shortest of the three.
       *
       * Everything else about the gesture happens now: the cursor moves,
       * visual stands down, the register is filled. So a second `dd`
       * inside the window names the row below, exactly as it would have,
       * and lands its own delete behind this one. What it does leave is a
       * row that is on screen but already condemned — a `u` typed inside
       * those 200ms takes back the step *before* this one, since this one
       * has not been filed yet. Reachable in theory, and 200ms is well
       * inside the reaction time it would take to notice and act.
       */
      flash(
        tasks.map((t) => t.id),
        "slain",
      );
      window.setTimeout(
        () => void run(ops, undoOps, `delete ${tasks.length}`),
        SLAIN_MS,
      );
      // The whole of visual, not half of it. This stood the mode and the
      // row anchor down but left `anchorCell` and `visualLine` set, which
      // was inert while only `dd` came through here — nothing outside
      // visual reads either. `V` + `d` arrives here now, so the leftover
      // `visualLine` would be a linewise flag surviving into the next
      // selection.
      enterMode("normal");
      putAnchor(null);
      putAnchorCell(null);
      putVisualLine(false);
      if (below && !tasks.some((t) => t.id === below.id)) putCursor(below.id);
    },
    [data, visible, run, putAnchorCell, putVisualLine, liveOnly, flash],
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

  /**
   * Put a yanked rectangle down with its top-left corner on `at`.
   *
   * Offset, not by column identity: the block keeps its shape and the
   * cursor says where it lands, which is what makes `start end` yanked
   * and dropped on `began` — comparing plan against record — the thing
   * the columns were for. `pastePlan` works out the pairing and what
   * does not fit; nothing here decides it.
   *
   * **Every cell goes through the command line it would have been typed
   * on**, the bargain `commitDate` and `commitOwner` already make. So a
   * summary's plan cell refuses itself, an actual span that would run
   * backwards refuses itself, and `:end` still writes a duration rather
   * than a date. None of those rules is restated here, which is the
   * point — a second copy is the one that goes stale.
   *
   * **`end` is written last**, in its own pass against fresh data. It
   * measures a duration back from the row's start, so a block carrying
   * both would otherwise compute the span against the start it is in the
   * middle of replacing — the trap #87 wrote down and the reason this is
   * two awaits rather than one loop.
   */
  const pasteCells = useCallback(
    async (row: Task | null, at: CellField) => {
      if (!liveOnly()) return;
      const block = cellRegister.current;
      if (!block?.rows.length) {
        say(t("nothing yanked"), "error");
        return;
      }
      if (!row || !data) {
        say(t("no task under the cursor"), "error");
        return;
      }

      const plan = pastePlan(block, at, cellColumns(columns));
      const top = visible.findIndex((task) => task.id === row.id);
      const targets = visible.slice(top, top + block.rows.length);
      const filedBefore = undoStack.current.length;

      /** Rows that ran off the bottom, columns that could not land. */
      const shortRows = block.rows.length - targets.length;
      const refused = plan.filter((pair) => pair.refused);

      let live = data;
      let wrote = 0;
      let failed = 0;
      // `end` after everything else — see the note above.
      for (const pass of [false, true]) {
        const ops: Op[] = [];
        const undoOps: Op[] = [];
        for (const [r, target] of targets.entries()) {
          const found = live.tasks.find((task) => task.id === target.id);
          if (!found) continue;
          // Advanced as each cell lands, so the next one is validated
          // against what this paste has already put on the row rather
          // than against what it is replacing. Without it `:astart`
          // measures itself against an `actual_end` that is on its way
          // out, and a good span half-lands — a new finish beside the
          // old start, which is worse than refusing the pair outright.
          let row = found;

          const cells = plan
            .map((pair, c) => ({ pair, c }))
            .filter(
              ({ pair }) =>
                !pair.refused && pair.to && (pair.to === "end") === pass,
            );

          // `began` and `ended` constrain each other, so ordering is not
          // enough on its own — one of the two orders is always legal
          // and `actualsWriteFirst` says which. Everything else is
          // order-independent and keeps the columns' own order.
          const nextStart = cells.find(({ pair }) => pair.to === "astart");
          if (nextStart && cells.some(({ pair }) => pair.to === "aend")) {
            const value = block.rows[r][nextStart.c];
            if (actualsWriteFirst(value, row.actual_end) === "aend") {
              cells.sort(({ pair: a }, { pair: b }) =>
                a.to === "aend" ? -1 : b.to === "aend" ? 1 : 0,
              );
            }
          }

          for (const { pair, c } of cells) {
            const line = cellWriteLine(pair.to!, block.rows[r][c]);
            if (!line) continue;
            const result = runCommand(line, {
              data: live,
              visible,
              current: row,
              // One cell names one row, the way a click does — the
              // selection this paste came from is long gone.
              selection: [row],
              projects: projects.projects.map((p) => p.name),
            });
            if (!result || result.error) {
              failed++;
              continue;
            }
            if (result.ops) ops.push(...result.ops);
            if (result.undoOps) undoOps.push(...result.undoOps);
            // Carry the write forward locally. Only `patch` ops matter —
            // a cell edit never creates or deletes — and only for this
            // row, since `live` is what the *next* pass reads.
            for (const op of result.ops ?? []) {
              if (op.kind === "patch" && op.id === row.id) {
                row = { ...row, ...op.patch };
              }
            }
            wrote++;
          }
        }
        if (!ops.length) continue;
        const next = await run(ops, undoOps, "paste cells");
        if (!next) return;
        live = next;
      }

      const filed = undoStack.current.splice(filedBefore);
      if (filed.length > 1) {
        undoStack.current.push({
          redo: filed.flatMap((step) => step.redo),
          undo: filed.flatMap((step) => step.undo).reverse(),
          label: "paste cells",
        });
      } else if (filed.length) {
        undoStack.current.push(filed[0]);
      }

      // Never a silent truncation. A block that half landed looks
      // exactly like one that landed, and the columns it missed are the
      // ones you would not think to check.
      const skipped = [
        refused.some((pair) => pair.refused === "off the end") &&
          t("past the last column"),
        refused.some((pair) => pair.refused === "different kind") &&
          t("into a column of another kind"),
        shortRows > 0 && t("past the last row"),
        failed > 0 && t("{n} refused", { n: failed }),
      ].filter(Boolean) as string[];
      if (!wrote) {
        say(skipped.join(" · ") || t("nothing to paste"), "error");
        return;
      }
      say(
        skipped.length
          ? `${t("pasted {n}", { n: wrote })} · ${skipped.join(" · ")}`
          : t("pasted {n}", { n: wrote }),
        // Not an error — cells did land. But not a plain `ok` either,
        // because some did not and the row it stopped at is not
        // something the list makes obvious.
        skipped.length ? "info" : "ok",
      );
    },
    [columns, data, liveOnly, projects, run, visible],
  );

  /**
   * Empty every cell of a rectangle — `x` / `dl`, and `d` in visual.
   *
   * A clear is a put of nothing, so it runs the same command line a paste
   * of an empty cell would (`cellClear` → `cellWriteLine(cell, null)`) and
   * inherits the refusals with it: a summary's plan still refuses itself,
   * and a column with nothing stored behind it says so rather than being
   * written.
   *
   * **One pass, unlike `pasteCells`.** That one orders its writes because
   * the values validate against each other — `:astart` measured against an
   * `actual_end` on its way out, `:end` measured back from a `start` being
   * replaced. Every one of those checks is guarded on a date being
   * *given* (`commands.ts`, the `date &&` in the actuals), so a clear
   * meets none of them and no order can be wrong. `end` never runs at all.
   *
   * The rows come from the caller — the cursor's row in normal, the whole
   * selection in visual — and so do the columns, which is what lets one
   * body serve a 1×1 cell and a dragged block without a second rule about
   * which is which.
   */
  const clearCells = useCallback(
    async (rows: Task[], cols: CellField[]) => {
      if (!liveOnly()) return;
      if (!data || !rows.length) {
        say(t("no task under the cursor"), "error");
        return;
      }

      // Decided once for the whole rectangle: the columns are the same on
      // every row, so nothing here depends on which row it lands on.
      const plan = cols.map((cell) => ({ cell, clear: cellClear(cell) }));
      const lines = plan.flatMap(({ clear }) =>
        clear.kind === "line" ? [clear.line] : [],
      );
      const derived = plan.filter(({ clear }) => clear.kind === "refused");
      const titles = plan.filter(({ clear }) => clear.kind === "edit");

      const ops: Op[] = [];
      const undoOps: Op[] = [];
      let cleared = 0;
      let failed = 0;
      for (const row of rows) {
        // Read out of `data` rather than trusted from the caller: the poll
        // may have replaced the task since the selection was taken.
        const found = data.tasks.find((task) => task.id === row.id);
        if (!found) continue;
        for (const line of lines) {
          const result = runCommand(line, {
            data,
            visible,
            current: found,
            // One row at a time, so a refusal on a summary stops that row
            // rather than the whole gesture — `patchSelection` returns the
            // first error for the selection it is handed.
            selection: [found],
            projects: projects.projects.map((p) => p.name),
          });
          if (!result || result.error) {
            failed++;
            continue;
          }
          if (result.ops) ops.push(...result.ops);
          if (result.undoOps) undoOps.push(...result.undoOps);
          cleared++;
        }
      }

      if (ops.length && !(await run(ops, undoOps, "clear cells"))) return;

      // Nothing is dropped silently — the same rule `pasteCells` keeps.
      // A rectangle that half cleared looks exactly like one that cleared,
      // and the columns it missed are the ones nobody thinks to check.
      const skipped = [
        derived.length &&
          // Named by heading rather than by field, and translated the way
          // the heading is: `astart` is drawn as `began`, and in Japanese
          // `end` is drawn as 終了 — a message naming the field would be
          // pointing at a column the screen calls something else. Only
          // date fields ever land in `derived`, so the lookup always hits.
          t("{cols}: nothing stored to clear", {
            cols: derived
              .map(({ cell }) => t(dateHead(cell as DateField)))
              .join(" "),
          }),
        // Only ever reached from a rectangle. A lone title cell never gets
        // here: the key handler sends it to `cc`, which is what clearing a
        // title means when there is a caret to put in it.
        titles.length && t("a title is cleared with cc"),
        failed > 0 && t("{n} refused", { n: failed }),
      ].filter(Boolean) as string[];
      if (!cleared) {
        say(skipped.join(" · ") || t("nothing to clear"), "error");
        return;
      }
      say(
        skipped.length
          ? `${t("cleared {n}", { n: cleared })} · ${skipped.join(" · ")}`
          : t("cleared {n}", { n: cleared }),
        skipped.length ? "info" : "ok",
      );
    },
    [data, liveOnly, projects, run, visible],
  );

  /**
   * Run a step's ops, drawing the blade over what they do.
   *
   * `u` was the one gesture that changed the plan and left no mark on
   * it. Every other write has drawn since the strokes arrived — a row is
   * born, cut, slain — and taking one of those back is exactly as much
   * of an event, which is why it now draws the *inverse* stroke rather
   * than a stroke of its own: a restored task is born, a task an undone
   * `o` takes away is slain. Reading it off the ops rather than off the
   * step's label is what keeps that true for a `u` that undoes a paste
   * of forty rows as well as for one that undoes a `dd`.
   *
   * The removals go first and wait, the same bargain `deleteSelection`
   * makes and for the same reason: a row that is already gone has
   * nothing left to draw on. That wait is the only latency an undo
   * spends on an effect, it is the shortest of the strokes, and it is
   * only paid by a step that takes something away.
   *
   * `reorder` and the dep ops are deliberately silent. Flashing a
   * reorder means flashing every row in the list, which says nothing
   * about which one moved, and an edge has no `born` — the sever is a
   * stroke for cutting one, and there is no drawing of it back.
   */
  const runStep = useCallback(
    async (ops: Op[], label: string, kind: "undo" | "redo") => {
      const born: string[] = [];
      const slain: string[] = [];
      for (const op of ops) {
        if (op.kind === "restore") born.push(op.task.id);
        else if (op.kind === "patch") born.push(op.id);
        else if (op.kind === "delete") slain.push(op.id);
      }
      if (slain.length) {
        flash(slain, "slain");
        await new Promise((resolve) => window.setTimeout(resolve, SLAIN_MS));
      }
      try {
        setData(await applyOps(ops));
        // After the write, not before: the rows a restore brings back do
        // not exist to carry a class until the state that holds them has
        // landed.
        if (born.length) flash(born, "born");
        say(
          kind === "undo"
            ? t("undo: {label}", { label })
            : t("redo: {label}", { label }),
          "ok",
        );
        return true;
      } catch (e) {
        setMessage({ text: (e as Error).message, kind: "error" });
        void load();
        return false;
      }
    },
    [flash, load],
  );

  const undo = useCallback(async () => {
    if (!liveOnly()) return;
    const step = undoStack.current.pop();
    if (!step) {
      say(t("already at the oldest change"));
      return;
    }
    // Only a step that landed is a step you can redo — the same rule as
    // before the strokes were added, and `runStep` reports which it was
    // rather than swallowing it.
    if (await runStep(step.undo, step.label, "undo")) {
      redoStack.current.push(step);
    }
  }, [liveOnly, runStep]);

  const redo = useCallback(async () => {
    if (!liveOnly()) return;
    const step = redoStack.current.pop();
    if (!step) {
      say(t("already at the newest change"));
      return;
    }
    if (await runStep(step.redo, step.label, "redo")) {
      undoStack.current.push(step);
    }
  }, [liveOnly, runStep]);

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
    // `:split 40` is both: the view, from `ui.view` above, and the width.
    // `applySplit` clamps, so the message reports what was actually set
    // rather than what was typed.
    if (ui.listWidth !== undefined) {
      const next = clampSplit(ui.listWidth);
      applySplit(next);
      setListWidth(next);
      say(t("split at {n}%", { n: next }));
    }
    if (ui.focus !== undefined) setFocus(ui.focus);
    if (ui.asof !== undefined) setReferenceDate(ui.asof);
    if (ui.theme) {
      setTheme((prev) => {
        // Three values, two switches. `toggle` is office ⇄ everything
        // else, so it comes back from super as well — spelled
        // `prev === "light"` rather than `prev === "dark"` precisely for
        // that: the old form read super as "not dark" and sent `gt`
        // *deeper* into the neon end instead of out to the office.
        // `super-toggle` is the other switch, and lands on neon rather
        // than on whatever you were in before, because a mode that
        // remembered would make `gs` mean two different things.
        const next: Theme =
          ui.theme === "toggle"
            ? prev === "light"
              ? "dark"
              : "light"
            : ui.theme === "super-toggle"
              ? prev === "super"
                ? "dark"
                : "super"
              : ui.theme!;
        applyTheme(next);
        say(
          next === "light"
            ? t("office mode")
            : next === "super"
              ? t("SUPER YAIBA 刃 — everything at maximum")
              : t("neon mode"),
        );
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
    // `:level n` / `:level` / `:only` / `:all` all arrive here, and all of
    // them mean the same thing `zM` means — so they go through the same
    // expansion rather than setting a depth nothing reads.
    if (ui.foldLevel !== undefined) foldToDepth(ui.foldLevel);
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
      const existing = data.deps.find(
        (d) => d.from === row.id && d.to === linkAnchor,
      );
      // Removing carries the edge as it stands, so undo re-links at the
      // lag it had rather than at the default. Adding has no way to ask
      // for a lag — `:dep 3 +0` is where that lives — so it says the
      // default out loud.
      const dep = existing ?? {
        from: row.id,
        to: linkAnchor,
        lag_days: DEFAULT_LAG,
      };
      const exists = existing !== undefined;
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
  /**
   * Where a drop would put the row, asked mid-drag so the list can draw
   * it before the mouse commits.
   *
   * Answered by `dropOrder` — the same function the drop itself runs, on
   * the same tasks — rather than by a rule of thumb about which way the
   * pointer is travelling. That rule of thumb is wrong, and wrong in the
   * case the eye cannot check: dragging *downwards* the removal shifts
   * the target up and the row lands below it, but only while the two are
   * siblings. Across levels the row takes the target's slot and lands
   * *above* it in the same downward drag. Reading the answer out of the
   * order `dropOrder` returns is what keeps the line honest — a preview
   * that disagreed with the drop would be worse than no preview.
   *
   * `null` means no line: a drop that would refuse (itself, its own
   * descendant, a sorted view). The drop is still allowed to happen and
   * still says why in the status line, because "nothing is drawn" is not
   * an explanation and `:sort manual` is the part worth learning.
   */
  const planDrop = useCallback(
    (draggedId: string, targetId: string): "above" | "below" | null => {
      if (!data || sort !== "manual") return null;
      const dropped = dropOrder(data.tasks, draggedId, targetId);
      if (!dropped) return null;
      const landed = dropped.ids.indexOf(draggedId);
      const target = dropped.ids.indexOf(targetId);
      if (landed < 0 || target < 0) return null;
      return landed > target ? "below" : "above";
    },
    [data, sort],
  );

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
   *
   * Through `pinStartOps`, the same commit `:start` makes: a drop inside
   * a predecessor's lag adjusts the lag rather than sliding to tomorrow
   * on the recompute, and the note says so — the one edit a drag cannot
   * show coming, because the lag lives on the edge, not the bar.
   */
  const onMoveBar = useCallback(
    (id: string, days: number) => {
      const task = visible.find((t) => t.id === id);
      const sched = bySchedule.get(id);
      if (!data || !task || !sched) return;
      const next = addDays(sched.start, days);
      const pin = pinStartOps(data, task, next);
      if (typeof pin === "string") {
        say(pin, "error");
        return;
      }
      void run(pin.ops, pin.undoOps, `start ${next}`).then((ok) => {
        if (ok && pin.note) say(pin.note, "info");
      });
    },
    [data, visible, bySchedule, run],
  );

  /**
   * `.` / `,`: nudge the start a day later / earlier, count included.
   *
   * The keyboard twin of dragging the bar body — `+` / `-` move the end
   * by way of the duration, and this is the other grip. The duration is
   * untouched, the bar's computed start becomes a pin where it lands,
   * and the commit goes through `pinStartOps` exactly as the drag does,
   * so a shift into a predecessor's lag adjusts the lag there too
   * rather than being silently raised.
   */
  const shiftStart = useCallback(
    (tasks: Task[], delta: number) => {
      if (!data || !tasks.length) return;
      const ops: Op[] = [];
      const undo: Op[] = [];
      const notes: string[] = [];
      for (const task of tasks) {
        const sched = bySchedule.get(task.id);
        // A summary's dates are its children's; there is no bar to move.
        if (!sched || sched.summary) continue;
        const pin = pinStartOps(data, task, addDays(sched.start, delta));
        if (typeof pin === "string") {
          say(pin, "error");
          return;
        }
        ops.push(...pin.ops);
        undo.push(...pin.undoOps);
        if (pin.note) notes.push(pin.note);
      }
      if (!ops.length) return;
      const label = `start ${delta > 0 ? "+" : "−"}${Math.abs(delta)}d`;
      void run(ops, undo, label).then((ok) => {
        if (!ok) return;
        say(
          [tasks.length > 1 ? `${label} · ${tasks.length}` : label, ...notes].join(" · "),
          notes.length ? "info" : "ok",
        );
      });
    },
    [data, bySchedule, run],
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
      // A drag has nowhere to type a number, so it means the default —
      // stated rather than omitted, per the note on `Dep.lag_days`.
      const dep = { from, to, lag_days: DEFAULT_LAG };
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

  /**
   * Cut an edge — the arrow's click, and `:undep`.
   *
   * The one gesture the app already called cutting, and the one with no
   * blade in it: the arrow stopped being rendered and that was the whole
   * of it. It is severed on screen first and removed `SEVER_MS` later,
   * for the same reason a deleted row is held — an element that unmounts
   * on the click has nothing left to animate.
   *
   * Same bargain as the delete, and a cheaper one: an edge is not
   * something a second keystroke can name in the meantime.
   */
  const onUnlinkDep = useCallback(
    (dep: Dep) => {
      if (!liveOnly()) return;
      const key = depKey(dep);
      setSevering((prev) => new Set(prev).add(key));
      window.setTimeout(() => {
        setSevering((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        void run(
          [{ kind: "removeDep", dep }],
          [{ kind: "addDep", dep }],
          "unlink",
        );
      }, SEVER_MS);
    },
    [run, liveOnly],
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

  /**
   * The level a new sibling of `id` lands at.
   *
   * The same rule the key handler applies to the cursor row: a parent
   * whose task is gone reads as the root, which is where the list already
   * draws the row. Written out here because the `+` names a row directly
   * rather than going through the cursor.
   */
  const parentOfRow = useCallback(
    (id: string): string | null => {
      const row = data?.tasks.find((t) => t.id === id);
      if (!row || !data) return null;
      return effectiveParent(row, new Set(data.tasks.map((t) => t.id)));
    },
    [data],
  );

  /**
   * Open the owner panel over a row.
   *
   * Anchored the way `openDate` anchors the calendar: the owner cell when
   * the `:dates` columns are up, the cursor row when they are not, the
   * gantt bar when the list is gone entirely. A display mode is a choice
   * about what to look at, not a precondition for an edit — `co` reaches
   * this field from every view, exactly as `cs` / `ce` reach the dates.
   */
  const openOwner = useCallback((row: Task | null) => {
    if (!row) {
      say(t("no task under the cursor"), "error");
      return;
    }
    const box = (
      document.querySelector(`[data-owner-cell="${row.id}"]`) ??
      document.querySelector(".row--cursor") ??
      document.querySelector(
        `.gantt__row[data-task-id="${row.id}"] .gantt__bar`,
      )
    )?.getBoundingClientRect();
    setPickingOwner({
      id: row.id,
      anchor: box
        ? { left: box.left, top: box.top, bottom: box.bottom }
        : { left: 40, top: 60, bottom: 60 },
    });
  }, []);

  /**
   * Open the row menu on a right-click.
   *
   * The cursor moves to the row first, and that is not a convenience: the
   * commands the menu runs all act on the row under the cursor, so the
   * right-click has to *be* a cursor move for the menu to mean what it
   * says. It is the same thing a left-click already does.
   */
  const openRowMenu = useCallback(
    (id: string, x: number, y: number) => {
      putCursor(id);
      // A menu opened out of visual mode would show `dd` next to a block
      // the pointer did not choose. Right-clicking is a statement about
      // one row, so it ends the selection the way a left-click does.
      //
      // `leaveVisual`, not the mode and the anchor by hand: those are two
      // of the four pieces, and the two left behind are exactly the ones
      // AGENTS.md records as this bug class. It is reachable, not
      // theoretical — `selecting` is true in *command* mode too, so `V`,
      // right-click another row, `:` left a stale `visualLine` painting
      // the cursor row edge to edge under an open command line.
      leaveVisual();
      setRowMenu({ id, x, y });
    },
    [putCursor, leaveVisual],
  );

  /**
   * Run what the menu was pointing at.
   *
   * Through `runKey`, not through a reimplementation — which is the whole
   * design: the item advertises a key, so it had better be that key that
   * runs, refusals and status line and all.
   */
  const pickRowMenu = useCallback((action: MenuAction) => {
    setRowMenu(null);
    if (isCmdline(action)) {
      // `:note ` and friends: hand over the line rather than guessing at
      // prose. Mirrors the `:` case in `runKey`.
      setCmdline(action.cmd.slice(1));
      setCompletion(null);
      historyAt.current = history.current.length;
      enterMode("command");
      return;
    }
    runKeyRef.current(action.cmd);
  }, [enterMode]);

  /**
   * Commit a name picked out of the owner panel.
   *
   * Through `:assign`, not by patching the field — the same bargain
   * `commitDate` makes. That is what keeps the one-word rule, the `@`
   * stripping and the message in one place instead of two that drift.
   * `selection: [task]` because a click names one row, even in visual
   * mode where the keyboard's `:assign` takes the block.
   */
  const commitOwner = useCallback(
    (id: string, name: string | null) => {
      setPickingOwner(null);
      if (!data) return;
      const task = visible.find((t) => t.id === id);
      if (!task) return;
      const result = runCommand(`assign ${name ?? "none"}`, {
        data,
        visible,
        current: task,
        selection: [task],
        projects: projects.projects.map((p) => p.name),
      });
      if (!result) return;
      if (result.error) {
        say(result.error, "error");
        return;
      }
      if (result.ops) {
        void run(result.ops, result.undoOps ?? [], result.label ?? "assign");
      }
      if (result.message) say(result.message, "ok");
    },
    [data, visible, projects, run],
  );

  // ---- key handling -----------------------------------------------

  /**
   * Where the cursor actually is, out of the refs.
   *
   * Read from the refs rather than the memos, which are a render behind.
   * `v` `j` `yy` typed as one burst is the case that made this
   * necessary: React had not re-rendered by the time `yy` ran, so the
   * yank saw a null anchor and took the single row `v` was pressed on
   * while the screen showed a block. Two `j`s in a row had the same
   * shape — both moved from the same starting index, so the second went
   * nowhere.
   */
  const liveCursor = (): number => {
    const at = visible.findIndex((t) => t.id === cursorRef.current);
    return at >= 0 ? at : 0;
  };

  /**
   * Run one command — the parsed thing a key press means, not the press.
   *
   * Split from `onKey` so that something other than a keyboard can ask
   * for it. The row menu is that something: every item on it names a key,
   * and rather than reimplementing what the key does it calls this with
   * the same string, so a menu item cannot drift from the key it claims
   * to be. `commitOwner` and `commitDate` already make that bargain with
   * the `:` line; this is the same one, one level down.
   *
   * What stays in `onKey` is everything about the *event*: which overlay
   * owns the keyboard, the modifiers, `NORMALIZE`, the pending-key buffer
   * and the count. None of it means anything to a caller that already
   * knows which command it wants.
   */
  const runKey = (cmd: string, count = 1, counted = false) => {
    // Read the ref, not the state: see enterMode.
    const activeMode = modeRef.current;

    // These names shadow the memoised ones on purpose: the body below is
    // written against the live values. See `liveCursor`.
    const cursor = liveCursor();
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

    // Out of the ref, not the render, and clamped the way the list draws
    // it — `gd` off leaves one column, and a burst that walked right
    // before it must not act on a cell nothing is rendering.
    const atCell: CellField = cellCols.includes(cellRef.current)
      ? cellRef.current
      : "title";
    // The columns the selection covers. `V` pins it to the full width —
    // that is the whole difference between the two visual modes — and
    // outside visual there is no rectangle, only the cell you stand in.
    const selCols: CellField[] =
      activeMode === "visual"
        ? visualLineRef.current
          ? cellCols
          : cellSpan(anchorCellRef.current ?? atCell, atCell, cellCols)
        : [atCell];

    /**
     * Open whatever the cursor is standing in.
     *
     * One body for `i` / `I` / `a` / `A` / `cc` / `⏎`, because they
     * differ only in what `cellEdit` answers — a second copy behind the
     * insert keys is how they came to disagree with `⏎` in the first
     * place. It opens the same two panels `cs` / `ce` / `ca` / `cA` /
     * `co` do, so a locked date is refused once, in `openDate`.
     */
    const editHere = (key: EditKey): void => {
      const edit = cellEdit(key, atCell);
      if (edit.kind === "owner") {
        openOwner(current);
        return;
      }
      if (edit.kind === "date") {
        openDate(current, edit.field);
        return;
      }
      if (!current) return;
      // A cleared title costs nothing to back out of: `finishEdit`
      // refuses a blank one, so <esc> *and* <cr> both leave the old one.
      setEditing({
        id: current.id,
        value: edit.clear ? "" : current.title,
        caret: edit.caret,
      });
      enterMode("insert");
    };

    /** Fill the row register — `yy` / `Y`, and `y` under linewise `V`. */
    const yankRows = (rows: Task[]): void => {
      register.current = rows;
      lastYank.current = "rows";
      say(t("yanked {n}", { n: rows.length }), "ok");
      leaveVisual();
    };

    switch (cmd) {
      // ---- motion
      case "j":
        moveTo(cursor + count);
        break;
      case "k":
        moveTo(cursor - count);
        break;
      // `counted`, not `count > 1`: `1gg` and a bare `gg` both mean row
      // one, but `1G` means row one where `G` means the last. Only the
      // *presence* of a typed count separates them, so it is passed in
      // rather than inferred from the number.
      case "gg":
        moveTo(counted ? count - 1 : 0);
        break;
      case "G":
        moveTo(counted ? count - 1 : visible.length - 1);
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
        putAnchorCell(null);
        putVisualLine(false);
        setLinkAnchor(null);
        break;
      // `v` marks a corner, not a line. With `compact` up there is one
      // column, so the rectangle is one cell wide and this is the line
      // select it has always been; with `gd` up `l` widens it. Same
      // shape as the motion keys: the second dimension only exists once
      // there is a second column to have it in.
      case "v":
      case "V":
        // `V` from inside `v` widens to the whole row rather than
        // leaving, which is what vim does and what you want the moment
        // you realise the block was the wrong shape. Pressing the same
        // one twice is what leaves.
        if (activeMode === "visual" && visualLineRef.current === (cmd === "V")) {
          enterMode("normal");
          putAnchor(null);
          putAnchorCell(null);
          putVisualLine(false);
        } else if (activeMode === "visual") {
          putVisualLine(cmd === "V");
        } else if (current) {
          enterMode("visual");
          putAnchor(current.id);
          putAnchorCell(atCell);
          putVisualLine(cmd === "V");
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
      // Every way into an edit, and they all edit the cell the cursor is
      // standing in — `cellEdit` owns which one that is, so `⏎` below
      // runs the same line. `cc` included: it is spelled after the `c`
      // family but not governed by it, because on a cell `cc` means
      // *this* cell.
      case "i":
      case "I":
      case "a":
      case "A":
      case "cc":
        // `cmd` is the raw key buffer, so the case labels are what narrow
        // it — TypeScript cannot do that for a `string`.
        editHere(cmd as EditKey);
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
      // `o` for owner, and it opens the same panel the mouse does. Without
      // it the panel would be the first thing in yaiba reachable only by
      // clicking — `:assign` can set a name, but it cannot show you the
      // spellings already in use, which is the whole reason the panel
      // lists them.
      case "co":
        openOwner(current);
        break;
      case "<space>":
        toggleDone(selection);
        leaveVisual();
        break;
      // `x` is delete-what-is-under-the-cursor, which on a grid of cells
      // is the cell — the reading the date picker has always had for it
      // (`DatePicker.tsx`), lifted out of the panel and onto the grid so
      // the same key means the same thing in both. `dl` is vim's own
      // spelling of it and costs nothing to honour; `dh` deliberately
      // does not exist, because it would edit the cell *beside* the one
      // the cursor stands in and every edit key in yaiba refuses that.
      //
      // Done moved to `<space>`, which was already an undocumented alias
      // for it — so nothing was lost but the spelling everyone's fingers
      // knew, which is the cost of the key being worth more here.
      case "x":
      case "dl":
      case "d": {
        // `V` is linewise, so there is no rectangle to speak of: `d` and
        // `x` delete the rows, exactly as `dd` does. Only `v` selects
        // cells, and outside visual the "rectangle" is the one cell the
        // cursor stands in.
        if (activeMode === "visual" && visualLineRef.current) {
          // Stands visual down itself, the way `dd` has always relied on.
          deleteSelection(selection);
          break;
        }
        // A lone title cell has a caret to put somewhere, and a title
        // cannot be left blank — `finishEdit` refuses one — so clearing
        // it means `cc`. A rectangle has no caret, so there `cellClear`
        // reports the title column as skipped instead.
        if (
          selCols.length === 1 &&
          selCols[0] === "title" &&
          selection.length === 1
        ) {
          // Before the edit, not after: `leaveVisual` stands down unless
          // the mode is still `visual`, so opening the insert first would
          // leave the anchor behind for the next `v` to inherit.
          leaveVisual();
          editHere("cc");
          break;
        }
        void clearCells(selection, selCols);
        leaveVisual();
        break;
      }
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
      // Two registers, and they put into different worlds: rows create
      // tasks, cells overwrite fields on tasks that are already there.
      // `yy` / `Y` fill the first, `y` fills the second, and `p` puts
      // down whichever was filled last — see `lastYank`.
      case "yy":
      case "Y":
        yankRows(selection);
        break;
      // Only ever reached in visual: `y` is a prefix elsewhere.
      case "y": {
        // Which register is `v` against `V`, not which key: `V` selects
        // rows, so `V j j y` is the row yank `V j j Y` is. It read the
        // full width as a rectangle before, which made `V` mean one thing
        // to `y` and would have made it mean another to `d`.
        if (visualLineRef.current) {
          yankRows(selection);
          break;
        }
        const block: CellBlock = {
          cols: selCols,
          rows: selection.map((task) =>
            selCols.map((col) => cellRead(col, task, bySchedule.get(task.id))),
          ),
        };
        cellRegister.current = block;
        lastYank.current = "cells";
        say(
          t("yanked {rows}×{cols}", {
            rows: block.rows.length,
            cols: selCols.length,
          }),
          "ok",
        );
        leaveVisual();
        break;
      }
      case "p":
        if (lastYank.current === "cells") void pasteCells(current, atCell);
        else void paste(current?.id ?? null, "after", cursorParent);
        break;
      case "P":
        // A cell block has no "before": it overwrites where you point it
        // rather than making room, so there is no side to land on. `P`
        // stays the row paste it always was.
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
      case ".":
        shiftStart(selection, count);
        break;
      case ",":
        shiftStart(selection, -count);
        break;
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
      // Edit the cell under the cursor — one key for all six, where `cs`
      // / `ce` / `ca` / `cA` / `co` are five keys that each name one.
      // Those stay: they reach a field from any view without walking to
      // it, and a display mode is not a precondition for an edit. This is
      // what the walk is *for*, and it opens the same panels they do.
      //
      // On the title it enters what is there rather than clearing it:
      // `cc` is the one that means "change the line", and `⏎` says "edit
      // this cell", which on every other column opens what is already in
      // it. `cellEdit` is where that is written down.
      //
      // The link modes keep it while they are up. They own the keyboard
      // by then, and `⏎` is how they commit.
      case "<cr>":
        if (activeMode === "link") commitLink(current, false);
        else if (activeMode === "unlink") commitLink(current, true);
        else editHere("<cr>");
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
      case "T":
        scrollToReference();
        break;
      // ---- folding by depth, which is folding by row underneath
      case "zm": {
        // Fold one level shallower. From "everything visible" that means
        // starting at the deepest level actually present, so the first
        // press always does something.
        const prev = foldLevelRef.current;
        foldToDepth(Math.max((prev ?? maxLevel) - 1, 0));
        break;
      }
      case "zr": {
        const prev = foldLevelRef.current;
        foldToDepth(prev === null || prev + 1 >= maxLevel ? null : prev + 1);
        break;
      }
      case "zM":
        foldToDepth(0);
        break;
      case "zR":
        foldToDepth(null);
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
      // One key each, like every other motion in this list. `h` and `l`
      // were free — they exist in NORMALIZE only so the arrow keys reach
      // the same cases, which means the arrows fold too, and that is the
      // behaviour a tree UI trains your hands for. A count has no meaning
      // on a fold, so it is ignored rather than applied.
      //
      // Two things answer to them now, and in this order: the cell to the
      // left or right, then the fold. They are the same motion — `h` is
      // "back out one step", and a cell is a smaller step than a
      // subtree — so the precedence is not a special case but what "one
      // step" means when the row is six cells wide (#87).
      //
      // Neither decision is taken here. `cellStep` says which of the two
      // owns the key and `foldStep` says what the fold does, both pure,
      // both asserted without a browser by `check-cells.ts` and
      // `check-folds.ts` — including that compact mode, with its single
      // column, still reaches `foldStep` with nothing in front of it.
      case "h":
      case "l": {
        if (!current) break;
        const move = cellStep(cmd === "l" ? "in" : "out", atCell, cellCols);
        if (!move) break;
        if (move.kind === "cell") {
          putCell(move.cell);
          break;
        }
        const step = foldStep(
          cmd === "l" ? "open" : "close",
          {
            id: current.id,
            summary: bySchedule.get(current.id)?.summary ?? false,
            parent: cursorParent,
          },
          collapsed,
        );
        if (step) {
          setCollapsed(step.collapsed);
          if (step.cursor !== current.id) putCursor(step.cursor);
          break;
        }
        // The fold declined — a leaf, or a summary already open. `l` then
        // has one reading left, which is the columns. `h` has none: there
        // is nothing to the left of the row itself.
        if (move.fallback) putCell(move.fallback);
        break;
      }
      case "zf":
        // Zoom into this subtree and drop every fold, so the focused
        // project opens fully rather than inheriting the outer view. That
        // has to clear `collapsed`, not just the remembered depth — the
        // depth stopped hiding anything by itself when the two axes were
        // merged, so clearing the depth alone left this comment lying.
        if (current) {
          setFocus(current.id);
          foldToDepth(null);
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

      case "gs":
        applyUi({ theme: "super-toggle" });
        break;

      case "R":
        void load();
        say(t("reloaded"), "ok");
        break;

      default:
        break;
    }
  };

  /**
   * A key press, turned into a command and handed to `runKey`.
   *
   * Everything here is about the event rather than the edit: which
   * overlay owns the keyboard, the modifiers, the pending-key buffer that
   * makes `dd` and `gp` two presses of one command.
   */
  const onKey = (e: KeyboardEvent) => {
    // Read the ref, not the state: see enterMode.
    const activeMode = modeRef.current;
    // The palette and the date picker each run their own input and own
    // every key while up, exactly as insert / command / search do.
    if (showProjects || picking || pickingOwner) return;
    // The row menu is the same bargain — it runs its own keyboard while
    // it is up, and hands back `esc`.
    if (rowMenu) return;
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

    if (e.ctrlKey || e.metaKey) {
      if (e.ctrlKey && !e.metaKey) {
        if (e.key === "d") moveTo(liveCursor() + HALF_PAGE);
        else if (e.key === "u") moveTo(liveCursor() - HALF_PAGE);
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

    // `y` and `d` are prefixes everywhere except in visual, where each is
    // the whole command: `v j j y` is what a block yank looks like, and
    // waiting for a second key there would make it `v j j yy` — a doubled
    // letter that means "the line" in a mode whose whole point is that you
    // have already said what you are acting on. Being a prefix is a
    // property of the mode, not of the key, which is exactly how vim
    // spends the same two letters.
    //
    // Nothing is lost on the second `d` of a habit: the first one fires
    // and leaves visual, so the second arrives in normal and simply waits
    // there. `d d` typed out of muscle memory is one delete and a pending
    // key, not two deletes.
    const prefix =
      cmd.length === 1 &&
      PREFIXES.has(cmd) &&
      !((cmd === "y" || cmd === "d") && activeMode === "visual");
    if (cmd === "" || prefix) {
      setPendingKeys(buf);
      return;
    }
    setPendingKeys("");
    setMessage(null);

    runKey(cmd, count, Boolean(match?.[1]));
  };

  // The handler closes over a lot of state; keeping it in a ref means
  // one listener for the life of the app instead of a re-subscribe on
  // every keystroke.
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  // Same trick, same reason — see the declaration up with the refs.
  runKeyRef.current = runKey;
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
  timeline.current = { rangeStart, today: data.today, dayW: DAY_W[zoom] };

  // Both can go missing under an open picker — a peer's delete, or a
  // filter that no longer matches — and then there is no cell to float
  // over any more.
  const pickingTask = picking
    ? (visible.find((t) => t.id === picking.id) ?? null)
    : null;
  const pickingColumn = picking
    ? (DATE_COLUMNS.find((c) => c.field === picking.field) ?? null)
    : null;
  const ownerTask = pickingOwner
    ? (visible.find((t) => t.id === pickingOwner.id) ?? null)
    : null;

  // Super mode's two screen-level effects. Both are decided here rather
  // than in the stylesheet because both would cost something outside
  // super mode: the burst is a grid child (see its state), and the
  // shake's class would sit on `.app` claiming an animation that mode
  // has no rule for.
  const superOn = theme === "super";
  const quake =
    superOn && burst?.kind === "slain"
      ? ` ${QUAKE_CLASSES[burst.n % 2]}`
      : "";

  return (
    <div className={`app${quake}`} ref={shellRef}>
      {/* Keyed on the counter, so each bump mounts a new node and the
          animation runs again — restarting one in place needs a reflow
          poke, and this says what it means. */}
      {wipe > 0 && <div key={wipe} className="wipe" aria-hidden="true" />}
      {superOn && burst && (
        <div
          key={burst.n}
          className={`burst burst--${burst.kind}`}
          aria-hidden="true"
        />
      )}
      {/* Typing draws its own blade — see `strike.ts`. It takes the
          shell rather than reaching for it, because the recoil is a
          class on this element and a component that queried the document
          for it would be one rename away from silently doing nothing. */}
      <Strikes enabled={superOn} shell={shellRef} />
      <Hud
        mode={mode}
        tasks={data.tasks}
        visibleCount={visible.length}
        criticalCount={data.schedule.critical_path.length}
        overdueCount={
          data.tasks.filter(
            (task) =>
              task.status !== "done" && bySchedule.get(task.id)?.overdue,
          ).length
        }
        lateCount={
          // Leaves only, because `late` rolls up: counting summaries as
          // well would report one overrun once for every ancestor
          // standing over it. And no status test beside it — unlike
          // `overdue`, the flag is already false for a done task.
          data.tasks.filter((task) => {
            const sched = bySchedule.get(task.id);
            return sched?.late && !sched.summary;
          }).length
        }
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
        foldLevel={visibleDepth}
        theme={theme}
        project={projects.active}
        projectCount={projects.projects.length}
        onOpenProjects={() => {
          setProjectError(null);
          setShowProjects(true);
        }}
        onToggleTheme={() => applyUi({ theme: "toggle" })}
        onToggleSuper={() => applyUi({ theme: "super-toggle" })}
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
            selectedCols={selectedCols}
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
            flashes={flashes}
            linkAnchor={linkAnchor}
            onlyPane={view === "list"}
            emptyHint={
              filter ? t("nothing matches this filter.") : t("no tasks yet.")
            }
            sort={sort}
            columns={columns}
            cell={cell}
            picking={picking}
            onOpenDate={(id, field, anchor) => setPicking({ id, field, anchor })}
            pickingOwner={pickingOwner?.id ?? null}
            onOpenOwner={(id, anchor) => setPickingOwner({ id, anchor })}
            // Both go through `openNew`, the one `o` uses, so a row born
            // from a click and one born from a key are the same row.
            onNewBelow={(id) => openNew(id, "after", parentOfRow(id))}
            onNewFirst={() => openNew(null, "after", null)}
            collapsed={collapsed}
            paneRef={listPane}
            onScroll={syncScroll(listPane)}
            onPick={onPick}
            onToggleDone={onToggleDone}
            onToggleFold={onToggleFold}
            onEditTitle={onEditTitle}
            onDropRow={onDropRow}
            planDrop={planDrop}
            onRowMenu={openRowMenu}
          />
        )}
        {/* Only in split: with one pane there is nothing to divide, and a
            grip against the window edge would have no room to be dragged
            back from. */}
        {view === "split" && (
          <SplitGrip percent={listWidth} onCommit={setListWidth} />
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
            flashes={flashes}
            severing={severing}
            onlyPane={view === "gantt"}
            paneRef={ganttPane}
            onScroll={syncScroll(ganttPane)}
            onRowMenu={openRowMenu}
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

      {/* Keyed on the row for the reason above: clicking from one open
          owner panel straight onto another row batches the close and the
          open into one render, and an unkeyed instance would carry the
          query you typed for the previous row into this one. */}
      {pickingOwner && ownerTask && (
        <OwnerPicker
          key={pickingOwner.id}
          value={ownerTask.assignee}
          names={ownerNames}
          anchor={pickingOwner.anchor}
          onPick={(name) => commitOwner(ownerTask.id, name)}
          onClose={() => setPickingOwner(null)}
        />
      )}

      {/* Keyed on the row, for the reason the owner panel is: right-
          clicking straight from one row onto another batches the close
          and the open, and an unkeyed instance would keep the highlight
          the pointer left on the previous one. */}
      {rowMenu && (
        <RowMenu
          key={rowMenu.id}
          at={rowMenu}
          onPick={pickRowMenu}
          onClose={() => setRowMenu(null)}
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
