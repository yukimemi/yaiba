/**
 * Where the split view divides — the list's share of the width.
 *
 * A property of how you like to look at the plan, the way the theme and
 * the language are, so it is remembered the same way: written to
 * localStorage and applied to `<html>` as a CSS variable before React
 * renders, so a reload does not flash the default width first.
 *
 * Applied as a variable rather than held in state because that is what
 * makes the drag smooth: `--list-w` is already what `.pane--list` sizes
 * itself from, so a pointer move can write one string and let the browser
 * do the rest, with no React render between the mouse and the pixels.
 */

const STORAGE_KEY = "yaiba:split";

/**
 * The list's share when nothing has been chosen.
 *
 * Matches the fallback baked into `.pane--list` so the two cannot drift:
 * a little under half, because a task title is more compressible than a
 * month of timeline.
 */
export const DEFAULT_SPLIT = 46;

/**
 * How narrow either side may get, in percent.
 *
 * Not zero: a pane dragged to nothing looks like a bug rather than a
 * choice, and there is no grip left to drag it back by — the divider
 * would be flush against the window edge. `:split` and `tab` are the way
 * to *hide* a pane, and they say so.
 */
export const MIN_SPLIT = 15;
export const MAX_SPLIT = 85;

export function clampSplit(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_SPLIT;
  return Math.round(Math.min(Math.max(percent, MIN_SPLIT), MAX_SPLIT));
}

/** Set the width now, and remember it. */
export function applySplit(percent: number): void {
  const next = clampSplit(percent);
  document.documentElement.style.setProperty("--list-w", `${next}%`);
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Private browsing, storage full, or a locked-down profile: the width
    // still applies for this session, it just won't be remembered.
  }
}

/**
 * Set the width *without* remembering it — what a drag in progress does.
 *
 * A drag writes on every pointer move, and persisting each one would put
 * a hundred writes into localStorage for one gesture. `applySplit` is
 * called once on release.
 */
export function previewSplit(percent: number): void {
  document.documentElement.style.setProperty(
    "--list-w",
    `${clampSplit(percent)}%`,
  );
}

/** The width to start at: whatever was chosen last, else the default. */
export function initialSplit(): number {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      const parsed = Number(saved);
      if (Number.isFinite(parsed)) return clampSplit(parsed);
    }
  } catch {
    /* unreadable storage — fall through to the default */
  }
  return DEFAULT_SPLIT;
}
