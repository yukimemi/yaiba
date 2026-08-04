/**
 * The blade under the caret — super mode's answer to typing.
 *
 * `flash.ts` draws the strokes a *task* earns: born, cut, slain. This is
 * the other half of the same idea one level down, at the scale of a
 * keystroke: every character cuts, so short strikes fly off the caret
 * and the shell takes the recoil. It is the power-mode gag, with the
 * blade in place of the sparks.
 *
 * Everything here is super mode only, and for the same reason the rest
 * of that section is: a task list that shakes while you name a task is
 * not something to inflict on somebody who did not ask for it. The CSS
 * lives under `:root[data-theme="super"]` with the rest, `check-flash.ts`
 * holds it there, and `Strikes` renders nothing at all in the other two
 * themes.
 *
 * The constants are here rather than inline because two of them are read
 * by both the component and the stylesheet's check, and the rest are the
 * numbers somebody tuning this will want to find in one place.
 */

/**
 * The shell's recoil, spelled twice — same bargain as `QUAKE_CLASSES` in
 * `flash.ts`, and for the same reason: a class swap restarts an
 * animation only when the name changes with it, and typing is the one
 * gesture that fires this many times a second. Separate from the delete
 * shake because it has to be a fraction of it — a 5px lurch under every
 * character would move the text out from under the caret.
 */
export const JOLT_CLASSES: [string, string] = ["app--jolt-a", "app--jolt-b"];

/**
 * How long a run of typing stays a run, in milliseconds.
 *
 * Stop for longer than this and the combo is over. Long enough to cover
 * thinking about the next word, short enough that walking away and
 * coming back starts again.
 */
export const COMBO_MS = 1200;

/**
 * The combo the counter starts showing at.
 *
 * Below it there is nothing to say: three characters is a word, not a
 * streak, and a readout appearing on every other keystroke is noise
 * beside the caret it is trying to celebrate.
 */
export const COMBO_FLOOR = 5;

/** Where the recoil and the strike count stop growing. */
export const COMBO_CAP = 40;

/** Strikes per keystroke, before the combo adds to it. */
export const STRIKES_MIN = 3;

/** And the most it ever adds. */
export const STRIKES_MAX = 8;

/**
 * The most strikes allowed on screen at once.
 *
 * A held key repeats at whatever the OS says, and a paste into the
 * command line commits in one event; neither is a reason to put four
 * hundred elements in the document. Past this the next keystroke draws
 * nothing rather than the layer growing without bound.
 *
 * It is also the only thing standing between the layer and a browser
 * that has stopped animating. A node takes itself out on `animationend`,
 * and a hidden tab freezes the document timeline entirely —
 * `document.timeline.currentTime` stops advancing, so nothing ever ends
 * and nothing is ever removed. A person cannot type into a tab they
 * cannot see, so this is mostly a harness's problem rather than a user's
 * (it is how the effect was verified, and it is why the automation notes
 * in AGENTS.md say what they do), but "mostly" is not a bound. This is.
 */
export const STRIKE_LIMIT = 120;

/** The recoil at full combo, in pixels. Small on purpose — see above. */
export const JOLT_MAX_PX = 3;
