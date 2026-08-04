/**
 * Every stroke the blade draws is drawn in both panes, and can be turned
 * off in both of the two ways this app has to turn effects off.
 *
 * `flash.ts` names the kinds; `styles.css` draws them. Nothing in
 * TypeScript can see whether a kind has a rule at all — the class name is
 * assembled from the kind (`row--${kind}`), so adding one to the union
 * and forgetting the CSS compiles perfectly and shows nothing. That is
 * the cheap failure. The expensive one is the other direction, and this
 * repo has already had it once: an effect that looks right in the dark
 * and cannot be got rid of on a shared screen, because its glow was
 * hardcoded rather than spent through `--glow`. So office mode and
 * `prefers-reduced-motion` are checked as hard requirements rather than
 * left to whoever adds the next stroke to remember.
 *
 * Run by `web-build`, so it gates every PR through `web.yml`. Same
 * bargain as `check-rowmenu.ts`: a rule that a browser would otherwise be
 * the only thing able to check, asserted without one.
 */

import { readFileSync } from "node:fs";

import {
  BURST_KINDS,
  BURST_MS,
  FLASH_KINDS,
  FLASH_MS,
  QUAKE_CLASSES,
  SEVER_MS,
} from "../src/flash.ts";
import { JOLT_CLASSES } from "../src/strike.ts";
import { THEMES } from "../src/theme.ts";

/**
 * The scope every super-mode rule carries.
 *
 * Written once here and asserted against `THEMES` below, because the
 * whole safety argument for the loud theme is that it is a *value* of
 * `data-theme` rather than a switch beside it: office mode is another
 * value of the same attribute, so no combination of settings can light
 * the effects over a white background.
 */
const SUPER = ':root[data-theme="super"]';

/**
 * The stylesheet with its comments taken out.
 *
 * Every rule below is found by looking for a class name in a selector,
 * and this file's comments are full of class names — the note above
 * `.gantt__link--severed` says what `Gantt` does with `.gantt__link-hit`.
 * Left in, a rule that had been deleted would still be "found", in the
 * paragraph explaining it.
 */
const css = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

let ran = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  ran++;
  if (ok) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures++;
  console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
}

// ---- reading the stylesheet -----------------------------------------

/** A braced block, by the text that opens it: the whole of it, and its body. */
function block(header: string): { whole: string; body: string } {
  const at = css.indexOf(header);
  if (at < 0) return { whole: "", body: "" };
  const start = css.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        return { whole: css.slice(at, i + 1), body: css.slice(start + 1, i) };
      }
    }
  }
  return { whole: "", body: "" };
}

const motion = block("@media (prefers-reduced-motion: reduce)");
const reduced = motion.body;
check(
  "the reduced-motion block exists",
  reduced.length > 0,
  "no `@media (prefers-reduced-motion: reduce)` in styles.css",
);

/**
 * Every innermost `selector { body }` pair outside that block.
 *
 * `[^{}]` on both halves is what makes it innermost: an `@media` header
 * cannot match a body containing a further `{`, so a match starting there
 * fails and the scan slides on to the rules inside. Which also means the
 * nesting is invisible in the result — a rule from inside the block would
 * be indistinguishable from a top-level one — so the block is cut out of
 * the text first rather than filtered out of the matches afterwards.
 * `@keyframes` steps come back looking like rules, which is harmless:
 * nothing here asks about a selector it did not name.
 */
const rules = [
  ...css.replace(motion.whole, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => ({ selector: m[1], body: m[2] }));

const isOffice = (selector: string) =>
  selector.includes(':root[data-theme="light"]');

/** Rules whose selector is scoped to office mode. */
const officeRules = rules.filter((r) => isOffice(r.selector));

/** Rules that draw rather than un-draw. */
const drawing = rules.filter((r) => !isOffice(r.selector));

/** The longest animation any drawing rule matching `sel` asks for, in ms. */
function longestMs(sel: string): number {
  let ms = 0;
  for (const rule of drawing) {
    if (!rule.selector.includes(sel)) continue;
    for (const m of rule.body.matchAll(/animation:\s*[\w-]+\s+(\d+)ms/g)) {
      ms = Math.max(ms, Number(m[1]));
    }
  }
  return ms;
}

/**
 * Is there a rule that actually animates `sel`?
 *
 * `none` is a word like any other, so a bare `[\w-]` here counted
 * `animation: none` as a stroke — and the two ways to silence one are
 * spelled exactly that. A rule outside both of those scopes that turns
 * the animation off is the one thing this check exists to catch, and it
 * was the one thing that satisfied it.
 */
const draws = (sel: string) =>
  drawing.some(
    (r) => r.selector.includes(sel) && /animation:\s*(?!none\b)[\w-]/.test(r.body),
  );

const officeSilences = (sel: string) =>
  officeRules.some(
    (r) => r.selector.includes(sel) && /animation:\s*none/.test(r.body),
  );

// ---- one stroke, both panes -----------------------------------------

for (const kind of FLASH_KINDS) {
  for (const sel of [`.row--${kind}`, `.gantt__bar--${kind}`]) {
    check(
      `${kind}: ${sel} is drawn`,
      draws(sel),
      `no rule in styles.css gives "${sel}" an animation. A kind in ` +
        `FLASH_KINDS with no stroke is a class the app adds and removes ` +
        `with nothing on screen either way.`,
    );
    check(
      `${kind}: ${sel} stands down under reduced motion`,
      reduced.includes(sel),
      `"${sel}" is missing from the @media (prefers-reduced-motion: ` +
        `reduce) block.`,
    );
    check(
      `${kind}: ${sel} stands down in office mode`,
      officeSilences(sel),
      `"${sel}" has no :root[data-theme="light"] rule setting ` +
        `animation: none. Office mode has to survive a shared screen.`,
    );
  }

  // The class is pulled on a timer; an animation outlasting it is cut
  // off part-played rather than finishing into its `forwards` state.
  // Both selectors, because one timer pulls both: asking only the row's
  // left the bar free to animate for longer than the class it rides on.
  const ms = Math.max(
    longestMs(`.row--${kind}`),
    longestMs(`.gantt__bar--${kind}`),
  );
  check(
    `${kind}: the stroke fits in the ${FLASH_MS[kind]}ms the class is held`,
    ms <= FLASH_MS[kind],
    `styles.css animates .row--${kind} / .gantt__bar--${kind} for ${ms}ms, ` +
      `and flash.ts removes the class after ${FLASH_MS[kind]}ms.`,
  );
}

// ---- the two strokes that are not on a task -------------------------

// A severed edge and the shell-wide wipe carry no `FlashKind`, and are
// exactly the two most likely to be forgotten in the lists above.
for (const sel of [".gantt__link--severed", ".gantt__arrow--severed", ".wipe"]) {
  check(`${sel} is drawn`, draws(sel));
  check(`${sel} stands down under reduced motion`, reduced.includes(sel));
  check(`${sel} stands down in office mode`, officeSilences(sel));
}

// The path and its arrowhead are one gesture on one timer, so the slower
// of the two is what has to fit — same pairing as the row and its bar.
const severMs = Math.max(
  longestMs(".gantt__link--severed"),
  longestMs(".gantt__arrow--severed"),
);
check(
  `the sever fits in the ${SEVER_MS}ms the edge is held on screen`,
  severMs <= SEVER_MS,
  `styles.css animates .gantt__link--severed / .gantt__arrow--severed for ` +
    `${severMs}ms, and flash.ts removes the edge after ${SEVER_MS}ms.`,
);

// ---- super mode -----------------------------------------------------
//
// The loud theme is a whole section of animations rather than a handful,
// so it is held to properties rather than to a list of selectors: a
// list here would be the second list to keep in step, which is the drift
// this file exists to catch. The three properties are the ones the
// section's own comment claims, and each has already been got wrong once
// somewhere in this stylesheet's history.

check(
  "super is a theme value, not a second switch",
  THEMES.includes("super"),
  `theme.ts no longer has a "super" theme, and everything below is ` +
    `checking a stylesheet section nothing can reach.`,
);

/** Rules scoped to the loud theme. */
const superRules = rules.filter((r) => r.selector.includes(SUPER));

check(
  "super mode has rules at all",
  superRules.length > 0,
  `no rule in styles.css is scoped ${SUPER}.`,
);

// 1. Office mode cannot be reached from here. `data-theme` holds one
//    value, so scoping every rule to this one is what makes that true —
//    a rule that forgot the scope would light up on a shared screen, and
//    it would do it in the mode that has no way to turn it off.
for (const sel of [".burst", ".app--quake", ".app--jolt", ".strike", ".combo"]) {
  const stray = rules.filter(
    (r) => r.selector.includes(sel) && !r.selector.includes(SUPER),
  );
  check(
    `${sel} is drawn in super mode only`,
    stray.length === 0,
    `these rules mention "${sel}" without ${SUPER}: ` +
      stray.map((r) => r.selector.trim()).join(" / "),
  );
}

// 2. Every element super mode conjures rests invisible. The blanket
//    `animation: none` under reduced motion is what turns the section
//    off, and it can only do that for an effect whose resting state is
//    nothing — otherwise stopping the clock leaves a sweep frozen
//    half-way across the screen.
for (const rule of superRules) {
  if (!/content:\s*""/.test(rule.body)) continue;
  check(
    `${rule.selector.trim()} rests at opacity 0`,
    /opacity:\s*0\b/.test(rule.body),
    `it draws itself out of nothing, so under prefers-reduced-motion — ` +
      `where its animation is turned off — whatever it paints is what ` +
      `stays on screen.`,
  );
}

check(
  "super mode stands down under reduced motion",
  /:root\[data-theme="super"\][\s\S]*animation:\s*none\s*!important/.test(
    reduced,
  ),
  `the @media (prefers-reduced-motion: reduce) block has no blanket ` +
    `animation: none !important for ${SUPER}.`,
);

// 3. The screen's own answers exist, and the shake is spelled twice.
for (const kind of BURST_KINDS) {
  check(`burst: .burst--${kind} is drawn`, draws(`.burst--${kind}`));
  // Same bargain as a stroke's, and it arrived for a second reason: the
  // burst is unmounted on this timer so that entering super mode later
  // cannot replay a gesture that is over. Too short a window and the
  // node goes while it is still playing.
  const ms = longestMs(`.burst--${kind}`);
  check(
    `burst: ${kind} fits in the ${BURST_MS[kind]}ms it is mounted for`,
    ms <= BURST_MS[kind],
    `styles.css animates .burst--${kind} for ${ms}ms, and App.tsx drops ` +
      `the burst after ${BURST_MS[kind]}ms.`,
  );
}

// Both shakes are spelled twice — the delete's and typing's recoil —
// because a class swap restarts an animation only when the name changes
// with it. That makes each pair two things a copy-paste can get wrong:
// naming one animation for both classes (nothing restarts), and letting
// the two keyframes drift (the effect depends on the parity of how many
// times it has run, which nobody will ever debug).
const frames = (cls: string) =>
  block(`@keyframes super-${cls.replace("app--", "")}`).body;

for (const [what, pair] of [
  ["shake", QUAKE_CLASSES],
  ["recoil", JOLT_CLASSES],
] as const) {
  for (const cls of pair) check(`${cls} is drawn`, draws(`.${cls}`));
  check(
    `the ${what} names two different animations`,
    new Set(
      superRules
        .filter((r) => pair.some((c) => r.selector.includes(c)))
        .flatMap((r) =>
          [...r.body.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1]),
        ),
    ).size === pair.length,
    `both classes name the same @keyframes, so swapping between them ` +
      `restarts nothing — the second one in a row would not play.`,
  );
  const [a, b] = pair.map(frames);
  check(
    `the ${what} is the same either way round`,
    a.length > 0 && a.replace(/\s+/g, "") === b.replace(/\s+/g, ""),
    `@keyframes ${pair.map((c) => `super-${c.replace("app--", "")}`).join(" and ")} ` +
      `have drifted apart. They are two names for one effect; it should ` +
      `not look different depending on whether it was the odd one.`,
  );
}

// 4. The one effect the blanket above cannot save.
//
// `.strike` nodes are created by `Strikes.tsx` and take themselves out on
// `animationend`. Turn the animation off and the event never comes, so
// the component has to decline to make them in the first place — which
// is behaviour no stylesheet check can see. Asserting the source
// mentions the query at all is crude, and it is the difference between a
// deliberate gate and nobody having thought about it.
const strikes = readFileSync(
  new URL("../src/components/Strikes.tsx", import.meta.url),
  "utf8",
);
check(
  "the strikes decline to spawn under reduced motion",
  strikes.includes("prefers-reduced-motion"),
  `Strikes.tsx never asks. Its nodes are removed on animationend, and ` +
    `with the animation silenced that event never fires — so every ` +
    `keystroke would leak an element that nothing takes out.`,
);

console.log(`\nflash: ${ran} checks, ${failures} failed`);
if (failures) process.exit(1);
