/**
 * The blade, as the three moments it is drawn on a task.
 *
 * Completion has always been the signature — `x` sweeps a cyan-to-magenta
 * stroke across the row and leaves the line-through behind. The other two
 * are the same object seen at the other two ends of a task's life:
 *
 *   born  — a task is created. The draw: left to right, cyan alone.
 *   cut   — a task is completed. The signature, unchanged.
 *   slain — a task is deleted. The cut without the magenta, and the row
 *           falls away from the stroke rather than staying under it.
 *
 * Kept in one file because three things have to agree and two of them are
 * not TypeScript: the class name the element carries (`row--cut`,
 * `gantt__bar--cut`), the CSS that draws it, and — for the two strokes
 * that precede a destructive act — how long the app waits before actually
 * doing it. `check-flash.ts` is what holds them together; it reads
 * `styles.css` and fails the build when a kind added here has no stroke,
 * or has one that office mode and `prefers-reduced-motion` do not turn
 * off. Both of those are the failure this repo has already had once, in
 * the `--glow` note in AGENTS.md: an effect that looks right in the dark
 * and cannot be got rid of on a shared screen.
 */

import type { Dep } from "./types";

export type FlashKind = "born" | "cut" | "slain";

export const FLASH_KINDS: FlashKind[] = ["born", "cut", "slain"];

/**
 * How long the class stays on the element, in milliseconds.
 *
 * At least as long as the CSS animation it triggers — a stroke whose
 * class is pulled mid-sweep vanishes rather than finishing. `cut` is
 * deliberately longer than its 340ms animation, which is the timing it
 * shipped with.
 */
export const FLASH_MS: Record<FlashKind, number> = {
  born: 300,
  cut: 400,
  slain: 200,
};

/**
 * How long a delete waits before it runs.
 *
 * The row has to still be on screen for the stroke to cross it, so
 * `deleteSelection` flashes first and files the ops on a timer. This is
 * the whole cost of the effect and it is why it is 200ms rather than the
 * cut's 340: it is time the app spends not doing what you asked.
 */
export const SLAIN_MS = FLASH_MS.slain;

/**
 * The same bargain for an edge, matching `sever` in `styles.css`.
 *
 * Cutting a dependency is the one gesture that is *called* cutting, and
 * until now it was the one with no blade in it — the arrow simply stopped
 * being rendered.
 */
export const SEVER_MS = 220;

/**
 * An edge's identity for the "currently being severed" set.
 *
 * Deps have no id of their own; `from`/`to` is the pair the server treats
 * as unique, and it is already what `Gantt` keys the rendered edge on.
 *
 * The separator is one ordinary space, stated here because it was a NUL
 * byte when this shipped for review: task ids are UUIDs and cannot
 * contain either, so any joiner works — but a control character makes
 * git call the file binary, and a file with no diff is a file nobody
 * reviews. Keep it printable.
 */
export const depKey = (dep: Pick<Dep, "from" | "to">): string =>
  `${dep.from} ${dep.to}`;

/**
 * Super mode's answer to a stroke, at the scale of the whole screen.
 *
 * The three strokes above are drawn on the thing they happen to. In
 * super mode the screen answers as well: a burst over everything
 * (`.burst--${kind}`, one element keyed on a counter, exactly the way
 * `.wipe` is) and, for a delete, a shake.
 *
 * Neither is rendered outside super mode — see the note on `burst` in
 * `App.tsx`. The class names live here rather than inline for the same
 * reason the kinds do: `check-flash.ts` holds `styles.css` to them, and
 * a burst with no rule behind it is an element that costs a render and
 * draws nothing.
 */
export const BURST_KINDS = FLASH_KINDS;

/**
 * How long the burst element stays mounted, in milliseconds.
 *
 * Longer than the CSS animation it triggers, exactly as `FLASH_MS` is —
 * and `check-flash.ts` fails the build if a burst outlasts its window.
 * The reason it is *taken down* at all is less obvious: the burst is
 * rendered only in super mode, so one left standing is one that plays
 * again the moment somebody presses `gs`, replaying a gesture that
 * finished minutes ago. The shake rides the same state, so it would
 * likewise keep its class on the shell long after the 240ms it moves
 * for.
 *
 * Not `FLASH_MS`: two of the three bursts outlast the stroke on the row
 * (the row's `slain` is 200ms against the screen's 240), and clearing on
 * the row's timer would unmount them part-played.
 */
export const BURST_MS: Record<FlashKind, number> = {
  born: 400,
  cut: 420,
  slain: 260,
};

/**
 * The shake, spelled twice.
 *
 * An animation replays from a fresh node or from a different
 * `animation-name`, and the first is not available here: `.app` holds
 * the whole tree, so remounting it to shake it would take the focus, the
 * scroll positions and any open editor with it. So two class names run
 * the same keyframes and consecutive deletes alternate between them —
 * the name changes, the animation restarts, the tree stays put.
 */
export const QUAKE_CLASSES: [string, string] = ["app--quake-a", "app--quake-b"];
