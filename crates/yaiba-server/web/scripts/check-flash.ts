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

import { FLASH_KINDS, FLASH_MS, SEVER_MS } from "../src/flash.ts";

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

const draws = (sel: string) =>
  drawing.some(
    (r) => r.selector.includes(sel) && /animation:\s*[\w-]/.test(r.body),
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
  const ms = longestMs(`.row--${kind}`);
  check(
    `${kind}: the stroke fits in the ${FLASH_MS[kind]}ms the class is held`,
    ms <= FLASH_MS[kind],
    `styles.css animates .row--${kind} for ${ms}ms, and flash.ts removes ` +
      `the class after ${FLASH_MS[kind]}ms.`,
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

const severMs = longestMs(".gantt__link--severed");
check(
  `the sever fits in the ${SEVER_MS}ms the edge is held on screen`,
  severMs <= SEVER_MS,
  `styles.css animates .gantt__link--severed for ${severMs}ms, and ` +
    `flash.ts removes the edge after ${SEVER_MS}ms.`,
);

console.log(`\nflash: ${ran} checks, ${failures} failed`);
if (failures) process.exit(1);
