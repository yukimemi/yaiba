/**
 * The view, as a URL fragment: `#v=1&p=<ticket>&view=split&sort=due&…`.
 *
 * Pure and DOM-free — it turns a state object into a string and back, and
 * nothing else — so `check-urlstate.ts` can run it. App.tsx owns every
 * side effect: reading `location`, `history.replaceState`, the clipboard,
 * and the confirmation before a join.
 *
 * In the fragment, not the path or query, because the server serves one
 * embedded SPA for every path and a fragment is never sent to it: no
 * route, no log line, no server change.
 *
 * What is here is what makes a link land on the same screen. What is
 * *not* — theme, colours, language, the split-pane width, and everything
 * transient (mode, pending keys, panels, drafts, selection) — is the
 * recipient's own.
 *
 * Every value comes from a stranger, so nothing here throws: a field that
 * does not parse is dropped and the rest still applies, the way
 * `initialViewState` treats a blob from another version.
 */
import type { Columns, View, Zoom } from "./commands";
import type { SortKey } from "./filter";
import { asColumns, asSort, asView, asZoom } from "./uiState";

/** What a link carries. Every field is optional: a link may say little. */
export interface LinkState {
  /** The project's peer ticket, verbatim. Validate with `parseTicket`. */
  project?: string;
  view?: View;
  zoom?: Zoom;
  columns?: Columns;
  sort?: SortKey;
  /**
   * List hidden tasks too (`zH`). The flag exists in this tree, so it
   * travels: without it a link to "the plan with the hidden rows shown"
   * would open on a plan that looks like it lost tasks.
   */
  showHidden?: boolean;
  /** The free-text query of filter.ts, verbatim. */
  filter?: string;
  /** Every folded summary's id. */
  fold?: string[];
  /** The focused subtree's root. */
  focus?: string;
  /** The reference date (`:asof`), `YYYY-MM-DD`. */
  asof?: string;
  /** The row the cursor was on. */
  cursor?: string;
  /**
   * Set by the decoder when the link carries the `v` marker, i.e. it was
   * written by `encodeLink` and describes the whole view. For such a link
   * a missing filter / fold / focus / asof means "none", where in a
   * hand-typed fragment it means "leave mine alone". Never encoded.
   */
  complete?: boolean;
}

/**
 * The most a fragment may be before the fold list is dropped from it.
 *
 * The fold list is the only field that grows with the plan: a task id is
 * a 36-character uuid, so 2000 characters holds roughly fifty folded
 * summaries beside the fixed fields. Browsers and chat tools accept far
 * more than that, but a link that wraps across a screen of a chat window
 * gets mangled, and 2000 is the figure the oldest clients still honour.
 */
export const MAX_FRAGMENT = 2000;

/** Bumped only if a field ever changes meaning; ignored on the way in. */
const VERSION = "1";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date — `2026-02-30` has the right shape and is not one. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * A ticket is `<endpoint-id>.<room-key>` (yaiba-sync's `Ticket`): an
 * alphanumeric endpoint id and a hex room key. Null when it is neither.
 */
export function parseTicket(
  ticket: string,
): { endpoint: string; room: string } | null {
  const m = /^([A-Za-z0-9]+)\.([0-9A-Fa-f]+)$/.exec(ticket.trim());
  return m ? { endpoint: m[1], room: m[2].toLowerCase() } : null;
}

/**
 * Whether two tickets name the same project.
 *
 * On the room key, not the endpoint id: the room is what a replica adopts
 * when it joins, so it is the same on every replica of a project, where
 * each replica's endpoint id (and hence its own ticket) is different —
 * the sender's ticket names *their* endpoint, and the recipient holds the
 * project under their own.
 */
export function sameProject(a: string, b: string): boolean {
  const x = parseTicket(a);
  const y = parseTicket(b);
  return x !== null && y !== null && x.room === y.room;
}

/**
 * The name the server files a joined project under when none is given:
 * projects.rs `name_from_ticket`, mirrored so the confirmation can say
 * what the project will be called before anything is created.
 */
export function projectNameFromTicket(ticket: string): string {
  const endpoint = ticket.split(".")[0] ?? ticket;
  const short = endpoint.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase();
  return short ? `peer-${short}` : "peer";
}

const enc = encodeURIComponent;

/**
 * Encode a state as a fragment (without the leading `#`).
 *
 * Values go through `encodeURIComponent`, so a space is `%20`, never `+`,
 * and a filter round-trips byte for byte. When the result is longer than
 * `maxLength` the fold list is dropped and `foldDropped` says so — the
 * caller owes the user that sentence, since the link then opens with the
 * plan unfolded.
 */
export function encodeLink(
  state: LinkState,
  maxLength: number = MAX_FRAGMENT,
): { fragment: string; foldDropped: boolean } {
  const build = (withFolds: boolean): string => {
    const parts: string[] = [`v=${VERSION}`];
    if (state.project) parts.push(`p=${enc(state.project)}`);
    if (state.view) parts.push(`view=${enc(state.view)}`);
    if (state.zoom) parts.push(`zoom=${enc(state.zoom)}`);
    if (state.columns) parts.push(`cols=${enc(state.columns)}`);
    if (state.sort) parts.push(`sort=${enc(state.sort)}`);
    if (state.showHidden !== undefined) {
      parts.push(`hid=${state.showHidden ? 1 : 0}`);
    }
    if (state.filter) parts.push(`q=${enc(state.filter)}`);
    if (withFolds && state.fold?.length) {
      // Ids are joined by a bare comma, which `encodeURIComponent` would
      // have escaped: each id is encoded and the separator is not.
      parts.push(`fold=${state.fold.map(enc).join(",")}`);
    }
    if (state.focus) parts.push(`focus=${enc(state.focus)}`);
    if (state.asof) parts.push(`asof=${enc(state.asof)}`);
    if (state.cursor) parts.push(`cur=${enc(state.cursor)}`);
    return parts.join("&");
  };
  const full = build(true);
  if (full.length <= maxLength || !state.fold?.length) {
    return { fragment: full, foldDropped: false };
  }
  return { fragment: build(false), foldDropped: true };
}

/**
 * Decode a pasted link, a full URL or a bare `#…` fragment, into the
 * fields it validly carries. Null when nothing usable is in it.
 *
 * Only what follows the first `#` is read: the origin of a pasted URL is
 * the sender's and is never looked at, let alone fetched. Text with no
 * `#` at all is taken as a fragment already, so `:open p=…&view=list`
 * works too.
 */
export function decodeLink(text: string): LinkState | null {
  let raw = text.trim();
  const hash = raw.indexOf("#");
  if (hash >= 0) raw = raw.slice(hash + 1);
  else if (/^[a-z]+:\/\//i.test(raw)) return null; // a URL with no fragment
  if (!raw) return null;

  const fields = new Map<string, string>();
  for (const part of raw.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    if (fields.has(key)) continue; // the first wins
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      continue; // malformed escape: this field only
    }
    fields.set(key, value);
  }

  const out: LinkState = {};
  const project = fields.get("p")?.trim();
  if (project) out.project = project;
  const view = asView(fields.get("view"));
  if (view) out.view = view;
  const zoom = asZoom(fields.get("zoom"));
  if (zoom) out.zoom = zoom;
  const columns = asColumns(fields.get("cols"));
  if (columns) out.columns = columns;
  const sort = asSort(fields.get("sort"));
  if (sort) out.sort = sort;
  const hid = fields.get("hid");
  if (hid === "1" || hid === "0") out.showHidden = hid === "1";
  const q = fields.get("q");
  if (q !== undefined) out.filter = q;
  const fold = fields.get("fold");
  if (fold) {
    const ids = [...new Set(fold.split(",").filter(Boolean))];
    if (ids.length) out.fold = ids;
  }
  const focus = fields.get("focus");
  if (focus) out.focus = focus;
  const asof = fields.get("asof");
  if (isIsoDate(asof)) out.asof = asof;
  const cursor = fields.get("cur");
  if (cursor) out.cursor = cursor;

  if (Object.keys(out).length === 0) return null;
  if (fields.has("v")) out.complete = true;
  return out;
}

/**
 * Drop the ids the project does not have.
 *
 * Task ids are the same on every replica, but a recipient may be behind
 * the sender (or, right after a join, have nothing yet), and an unknown
 * id folded or focused would show nothing. `complete` is whether every
 * id the link named was found — false means some may still arrive.
 */
export function pruneToIds(
  state: LinkState,
  ids: Iterable<string>,
): { state: LinkState; complete: boolean } {
  const known = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
  const out: LinkState = { ...state };
  let complete = true;
  if (state.fold) {
    const kept = state.fold.filter((id) => known.has(id));
    if (kept.length < state.fold.length) complete = false;
    if (kept.length) out.fold = kept;
    else delete out.fold;
  }
  if (state.focus !== undefined && !known.has(state.focus)) {
    complete = false;
    delete out.focus;
  }
  if (state.cursor !== undefined && !known.has(state.cursor)) {
    complete = false;
    delete out.cursor;
  }
  return { state: out, complete };
}
