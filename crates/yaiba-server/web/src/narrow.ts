/**
 * Whether the window is narrow enough that a phone is looking at it.
 *
 * One number, spelled twice on purpose. The stylesheet cannot read a
 * TypeScript constant and a media query cannot be interpolated from one
 * without giving up the static `@media` rule, so `styles.css` carries a
 * literal `@media (max-width: 720px)` beside this. `check-mobile.ts`
 * fails the build when the two stop agreeing — which is the failure this
 * duplication would otherwise cause: a layout that collapses to one pane
 * at a width where the touch affordances are still hidden, or the
 * reverse, in a band nobody has a window open at.
 *
 * 720 rather than a phone's own width because it is the point where two
 * panes stop being two panes: at 390px the split's ~46% list is under
 * 180px, which is a column of ellipses.
 *
 * Narrow is *not* touch. A desktop window dragged narrow gets the
 * one-pane layout and the touch bar, because both are about room; it
 * keeps every hover affordance, because those are about the pointer.
 * That half of the split lives in the stylesheet as `(hover: none)`.
 */

import { useSyncExternalStore } from "react";

export const NARROW_PX = 720;

/**
 * One list for the life of the page, built on first use.
 *
 * `matchMedia` returns a fresh object per call, and `useSyncExternalStore`
 * would then subscribe to one and read from another — correct, but it
 * allocates on every render of the whole app for an answer that changes
 * when the window is resized. So it is a singleton.
 *
 * Lazy rather than at module scope because `NARROW_PX` above is imported
 * by `check-mobile.ts`, which runs under bun with no DOM: touching
 * `window` while the module body evaluates made importing the number
 * throw, and a check that cannot read the constant it is pinning would
 * have to re-derive it from the source text — one more copy of the very
 * thing it exists to keep to one.
 */
let query: MediaQueryList | null = null;

function media(): MediaQueryList {
  query ??= window.matchMedia(`(max-width: ${NARROW_PX}px)`);
  return query;
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  return media().matches;
}

/**
 * Reads right on the *first* render, which is the whole reason this is
 * `useSyncExternalStore` and not `useState(false)` plus an effect: the
 * effect version paints one frame of the desktop layout before it
 * corrects itself, and on a phone that frame is two panes of roughly
 * 180px flashing past before the list arrives.
 */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}
