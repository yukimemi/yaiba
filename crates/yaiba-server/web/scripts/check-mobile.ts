/**
 * The phone layer, held to the rules it was built under.
 *
 * Three of the four things below are facts duplicated across files with
 * no compiler in between, which `AGENTS.md` names as the thing to write a
 * check for rather than a comment. The fourth is the row menu's boundary
 * seen from the other side.
 *
 * - **The breakpoint is one number in two languages.** `NARROW_PX` in
 *   `narrow.ts` decides which components render; `@media (max-width:
 *   720px)` in `styles.css` decides what they look like. Nothing makes
 *   them agree, and disagreeing is invisible: the layout simply changes
 *   at one width and the behaviour at another, in a band nobody has a
 *   device for.
 * - **Every button on the bar is a key.** `data-cmd` is what the bar
 *   hands `runKey`, so a value `runKey` has no case for is a button that
 *   silently does nothing.
 * - **The bar carries no per-row action.** That is the row menu's half of
 *   the app, and `check-rowmenu.ts` polices it from the menu's side; this
 *   is the same rule stated where the temptation is.
 * - **The grip is the contract the CSS styles.** The class name is the
 *   only thing tying a hidden-by-default rule to the element it hides.
 */

import { readFileSync } from "node:fs";

import { NARROW_PX } from "../src/narrow.ts";
import { menuCommands, ROW_MENU } from "../src/rowMenu.ts";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const bar = readFileSync(
  new URL("../src/components/TouchBar.tsx", import.meta.url),
  "utf8",
);
const list = readFileSync(
  new URL("../src/components/TaskList.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

let ran = 0;
let failures = 0;

function check(label: string, got: unknown, want: unknown): void {
  ran += 1;
  if (got === want) return;
  failures += 1;
  console.error(`FAIL ${label}\n  got  ${String(got)}\n  want ${String(want)}`);
}

// ---- the breakpoint ------------------------------------------------

const widths = [...css.matchAll(/max-width:\s*(\d+)px/g)].map((m) => Number(m[1]));

check("styles.css has at least one width query", widths.length > 0, true);
check(
  `every max-width query is NARROW_PX (${NARROW_PX})`,
  [...new Set(widths)].join(","),
  String(NARROW_PX),
);
// The grip has to be reachable on a touch device of any width and on a
// narrow window of any input kind, which is two conditions rather than
// one — so the literal appears more than once by design, and what
// matters is that they are all the same number, asserted above.
check(
  "the hover-none half of the grip query exists",
  /@media\s*\(hover:\s*none\)\s*,\s*\(max-width:\s*\d+px\)/.test(css),
  true,
);

// ---- the bar is keys, not actions ----------------------------------

// The keys come out of the bar's own table rather than off the rendered
// attribute, because the attribute is `data-cmd={cmd}` — one element
// built per entry. What ties the two together is asserted separately
// below: a table nothing renders would pass every check under it.
const cmds = [...bar.matchAll(/cmd:\s*"([^"]+)"/g)].map((m) => m[1]);
check("the bar has buttons", cmds.length > 0, true);
check(
  "and every one carries its key as data-cmd",
  /data-cmd=\{cmd\}/.test(bar),
  true,
);

/** Every `case "…":` label `runKey` answers. */
const cases = new Set(
  [...app.matchAll(/^\s*case\s+"([^"]+)":/gm)].map((m) => m[1]),
);
for (const cmd of cmds) {
  check(`runKey answers ${JSON.stringify(cmd)}`, cases.has(cmd), true);
}

// The rule the bar is bounded by, from the side that would break it: a
// per-row action on the bar is a second surface for the same edit, and
// the row menu is the one that knows which row — it opens over it.
//
// Two deliberate exclusions. `DIRECT_GESTURES` is not in the set,
// because those are already pointer-reachable: `o` is on the bar *and*
// on the `+` at the end of a row, and a second pointer route to a
// global key makes nothing stale. And an item the menu itself flags
// `global` is allowed, which is `undo` — see the flag's doc comment for
// why a phone needs it somewhere other than behind a long-press.
const rowKeys = new Set(
  menuCommands(ROW_MENU.filter((item) => !item.global)),
);
for (const cmd of cmds) {
  check(`${JSON.stringify(cmd)} is not a row action`, rowKeys.has(cmd), false);
}

// ---- the markup contract -------------------------------------------

check("the list renders the grip", list.includes('className="row__grip"'), true);
check("the grip is decorative to a screen reader", /row__grip[\s\S]{0,200}aria-hidden/.test(list), true);
check("styles.css styles the grip", css.includes(".row__grip"), true);
// Hidden by default and revealed by the query above: a grip that shipped
// visible on the desktop would be a column of handles nobody asked for.
check(
  "the grip is hidden before the query reveals it",
  /\.row__grip\s*\{[^}]*display:\s*none/.test(css),
  true,
);
check("styles.css styles the bar", css.includes(".touchbar"), true);

// ---- what a phone cannot do ----------------------------------------

// HTML5 drag-and-drop has no touch implementation at all, so a reorder
// built on it is a feature that simply does not exist on a phone. The
// pointer path replaced it; these keep it replaced.
//
// Comments are stripped first: the doc comment on the drag state names
// both APIs to record what used to carry this, and a check that failed on
// the file explaining itself would be a check against writing it down.
const code = list.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check("no draggable attribute survives", /\bdraggable\b/.test(code), false);
check("no dataTransfer use survives", code.includes("dataTransfer"), false);
// `e.target` at release is the grip, because touch and pen implicitly
// capture the pointer on whatever received `pointerdown` — the trap
// `AGENTS.md` records for the gantt, arriving here by the same route.
check(
  "the drop is hit-tested with elementFromPoint",
  list.includes("elementFromPoint"),
  true,
);

// The grip is hidden wherever there is a hover to reveal things with, so
// a drag keyed to the grip *alone* takes the reorder away from every
// desktop mouse — and leaves `DIRECT_GESTURES` advertising a "drag a
// row" that cannot happen. Caught in review, after the CSS and the
// component were each correct on their own.
check(
  "a mouse can still start a drag on the row",
  /pointerType === "mouse"[\s\S]{0,400}drag: true/.test(list),
  true,
);
check(
  "and the row itself is not selectable while it is one",
  /^\.row,\n\.gantt__bar \{\n  user-select: none/m.test(css),
  true,
);
check(
  "a promoted scroll clears the drag",
  list.includes("pointercancel"),
  true,
);

if (failures) {
  console.error(`mobile: ${failures} of ${ran} checks failed`);
  process.exit(1);
}
console.log(`mobile: ${ran} checks, all passing`);
