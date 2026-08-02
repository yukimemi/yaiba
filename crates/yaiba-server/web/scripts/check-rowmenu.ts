/**
 * The row menu holds what the mouse cannot otherwise reach — and only
 * that.
 *
 * The rule is written out in `rowMenu.ts`; this is what makes it true
 * tomorrow. A menu is easy to add one more useful thing to, and each one
 * is defensible on its own: fifteen items later it is a menu nobody
 * reads, and yaiba is quietly arguing that the keyboard is the second
 * path. So the boundary is asserted rather than remembered.
 *
 * It fails in the direction that actually happens. Nobody adds a direct
 * gesture and then remembers to delete the menu item it made redundant —
 * they add the gesture, ship it, and the menu keeps offering the same
 * thing twice in two places that will drift. Listing the gesture in
 * `DIRECT_GESTURES` is the one step, and this is what refuses the commit
 * without it.
 *
 * Run by `web-build`, so it gates every PR through `web.yml`. Same
 * bargain as `check-cells.ts`: a pure table, checked without a browser,
 * because `cargo make check` is Rust-only.
 */

import { DIRECT_GESTURES, ROW_MENU, isCmdline, menuCommands } from "../src/rowMenu.ts";

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

// ---- the rule itself ------------------------------------------------

const direct = new Map(DIRECT_GESTURES.map((g) => [g.cmd, g.gesture]));

for (const item of ROW_MENU) {
  for (const action of item.actions) {
    const clash = direct.get(action.cmd);
    check(
      `${item.id}: ${action.cmd} is not already a mouse gesture`,
      clash === undefined,
      clash
        ? `"${action.cmd}" is what "${clash}" already does. Either drop the ` +
          `menu item, or drop the gesture — the menu is for what the mouse ` +
          `cannot reach.`
        : "",
    );
  }
}

// ---- the things that make the rule checkable ------------------------

const seen = new Set<string>();
for (const item of ROW_MENU) {
  check(`${item.id}: id is unique`, !seen.has(item.id));
  seen.add(item.id);
}

// A duplicate command is two ways to say one thing in a panel whose
// whole argument is that it is short.
const commands = menuCommands();
check(
  "no command appears twice",
  new Set(commands).size === commands.length,
  `got ${commands.join(" ")}`,
);

for (const item of ROW_MENU) {
  check(`${item.id}: has a label`, item.label.trim().length > 0);
  check(`${item.id}: has a glyph`, item.glyph.trim().length > 0);
  // A two-way item is the only reason `side` exists, and an item with
  // two actions and no sides would draw two identical buttons.
  if (item.actions.length === 2) {
    check(
      `${item.id}: both sides are labelled`,
      item.actions.every((a) => (a.side ?? "").length > 0),
    );
  }
}

// The hint is what the user is told to type, so it has to be the thing
// that runs — modulo the trailing space a `:` prefill carries so the
// cursor lands after the command name.
for (const item of ROW_MENU) {
  for (const action of item.actions) {
    const want = isCmdline(action) ? action.cmd.trimEnd() : action.cmd;
    check(
      `${item.id}: the hint "${action.hint}" is the command it runs`,
      action.hint === want,
      `hint "${action.hint}" vs command "${want}"`,
    );
  }
}

// ---- what the menu is for -------------------------------------------

// The three that motivated the whole thing. A refactor that quietly
// drops one of these has removed the reason the menu exists, and should
// have to say so here.
for (const cmd of ["dd", "s", "u"]) {
  check(
    `the menu still reaches ${cmd}`,
    commands.includes(cmd),
    `"${cmd}" has no other mouse path; dropping it reopens the gap the ` +
      `menu was added to close.`,
  );
}

console.log(`\nrow menu: ${ran} checks, ${failures} failed`);
if (failures) process.exit(1);
