/**
 * UI state that survives a reload, in two scopes.
 *
 * The split follows the one the project switch already makes. Settings
 * that name no task — the view, zoom, columns and sort — are *global*,
 * kept in localStorage like the theme and language, because the switch
 * has always carried them across projects. State that names task ids —
 * folds, the focused subtree, the filter — is *per-project*, kept
 * server-side in the project database's `meta` table behind `/api/ui`:
 * the same id means nothing in another project, a rename keeps the
 * database (so the state survives it), and `meta` is not part of the CRDT
 * log, so how one replica folds its plan never syncs to a peer.
 */
import { COLUMNS, VIEWS, ZOOMS, type Columns, type View, type Zoom } from "./commands";
import { SORT_KEYS, type FoldMemory, type SortKey } from "./filter";

export interface ViewState {
  view: View;
  zoom: Zoom;
  columns: Columns;
  sort: SortKey;
}

const VIEW_STATE_KEY = "yaiba:view";

const DEFAULT_VIEW_STATE: ViewState = {
  view: "split",
  zoom: "day",
  columns: "compact",
  sort: "manual",
};

/**
 * The view state to start in: whatever was used last, else the defaults.
 * Unknown values are dropped field by field, so a blob written by another
 * version degrades instead of breaking the parse.
 */
export function initialViewState(): ViewState {
  try {
    const saved = localStorage.getItem(VIEW_STATE_KEY);
    if (!saved) return DEFAULT_VIEW_STATE;
    const parsed = JSON.parse(saved) as Partial<ViewState>;
    return {
      view: VIEWS.includes(parsed.view as View) ? (parsed.view as View) : "split",
      zoom: ZOOMS.includes(parsed.zoom as Zoom) ? (parsed.zoom as Zoom) : "day",
      columns: COLUMNS.includes(parsed.columns as Columns)
        ? (parsed.columns as Columns)
        : "compact",
      sort: SORT_KEYS.includes(parsed.sort as SortKey)
        ? (parsed.sort as SortKey)
        : "manual",
    };
  } catch {
    // Unreadable storage or unparseable JSON — start from the defaults.
    return DEFAULT_VIEW_STATE;
  }
}

export function saveViewState(state: ViewState): void {
  try {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing or a full quota: the state still applies for this
    // session, it just won't be remembered.
  }
}

/**
 * The per-project half, as `/api/ui` serves and accepts it. Every field
 * is optional so a blob from another version — or the `{}` a project
 * starts with — still parses.
 */
export interface ProjectUiState {
  /** Every folded summary's id. */
  collapsed?: string[];
  /** The focused subtree's root, or null. */
  focus?: string | null;
  filter?: string;
  /** The depth zm/zr step from — not the folds themselves. */
  foldLevel?: number | null;
  /**
   * What the folds were before the focus above opened the subtree, so
   * `zF` has something to put back after a reload as well.
   *
   * On disk rather than in memory alone because for as long as a focus
   * is up, the `collapsed` beside it *is* the empty set `zf` installed —
   * so a reload taken while focused would be the same loss (#135) by a
   * slower route. Absent, or null, when no focus is up.
   */
  foldMemory?: FoldMemory | null;
}
