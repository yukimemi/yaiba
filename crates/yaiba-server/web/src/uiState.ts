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
  /** List hidden tasks too. A view setting, so it stays on this device. */
  showHidden: boolean;
}

const VIEW_STATE_KEY = "yaiba:view";

// The one place a raw value becomes a view setting, shared by the
// localStorage read below and the URL fragment (urlState.ts): both are
// untrusted input that must degrade field by field.
export const asView = (v: unknown): View | undefined =>
  VIEWS.includes(v as View) ? (v as View) : undefined;
export const asZoom = (v: unknown): Zoom | undefined =>
  ZOOMS.includes(v as Zoom) ? (v as Zoom) : undefined;
export const asColumns = (v: unknown): Columns | undefined =>
  COLUMNS.includes(v as Columns) ? (v as Columns) : undefined;
export const asSort = (v: unknown): SortKey | undefined =>
  SORT_KEYS.includes(v as SortKey) ? (v as SortKey) : undefined;

const DEFAULT_VIEW_STATE: ViewState = {
  view: "split",
  zoom: "day",
  columns: "compact",
  sort: "manual",
  showHidden: false,
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
      view: asView(parsed.view) ?? "split",
      zoom: asZoom(parsed.zoom) ?? "day",
      columns: asColumns(parsed.columns) ?? "compact",
      sort: asSort(parsed.sort) ?? "manual",
      // Anything but a real true reads as off: hidden is the default.
      showHidden: parsed.showHidden === true,
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
