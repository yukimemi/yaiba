/**
 * What the row menu holds, and the rule that decides it.
 *
 * The mouse could reach about two thirds of what a row can do. The rest
 * — deleting it, marking it `doing`, its priority, its progress, its
 * nesting — had a key and nothing else, which is the exact
 * mirror of the thing `AGENTS.md` refuses in the other direction:
 *
 * > nothing in yaiba should be reachable *only* by clicking
 *
 * A menu is the cheap way to close that, and the expensive way to ruin
 * it. A menu that lists everything is fifteen items nobody reads, and it
 * quietly argues that the keyboard is the second-class path. So the
 * contents are decided by a rule rather than by taste:
 *
 * **An action belongs here exactly when the mouse cannot already reach
 * it, and every item names the key it runs.**
 *
 * Both halves earn their keep. The first bounds the menu and shrinks it
 * automatically — add a direct gesture for something and its item leaves,
 * without anyone having to argue about it. `check-rowmenu.ts` asserts it
 * against `DIRECT_GESTURES` below, so it is a property of the build
 * rather than a promise in a comment.
 *
 * The second makes the menu teach. Right-clicking to delete a row shows
 * you `dd`, so the mouse path advertises the keyboard one instead of
 * competing with it. It is also why this panel is the one overlay that
 * needs no keyboard opener, where `co` had to have one: `co` lists the
 * names already in use, which is information a key cannot give you, and
 * this lists keys, which `?` already does.
 */

/**
 * What an item does when picked, and how to label it.
 *
 * `cmd` is handed to `runKey` verbatim, which is what makes the item
 * honest — it cannot do something other than the key it advertises.
 *
 * A `cmd` beginning with `:` is the one other shape: it opens the
 * command line with that text already in it, rather than running
 * anything. `note` needs it, because a note is prose and no menu can
 * hold prose; naming `:note` and handing over the line is the most a
 * click can honestly do. The row is already under the cursor by then,
 * so the command acts on what was right-clicked.
 */
export interface MenuAction {
  /** A `runKey` command, or a `:`-prefixed line to open. */
  cmd: string;
  /** Shown on the item's right, as the user would type it. */
  hint: string;
  /** For a two-way item, the glyph on this side's button. */
  side?: string;
}

/** True when this action opens the command line instead of running a key. */
export function isCmdline(action: MenuAction): boolean {
  return action.cmd.startsWith(":");
}

export interface MenuItem {
  id: string;
  /** Passed through `t()` at render, like every other label. */
  label: string;
  glyph: string;
  /**
   * One action, or two opposed ones. Two is for the fields that only
   * move up and down — a menu cannot hold a number, and a submenu for
   * ±1 would be a worse answer than two buttons on one line.
   */
  actions: [MenuAction] | [MenuAction, MenuAction];
  /** Items are drawn in groups, separated by a rule. */
  group: "state" | "shape" | "edit";
  /**
   * The item acts on the app, not on the row it was opened over.
   *
   * Only `undo` so far, and it is on the menu for the reason its own
   * comment gives. The flag exists because the touch bar carries the
   * global keys, and `check-mobile.ts` refuses any overlap between the
   * two surfaces *except* here: a second route to a row action means two
   * places to keep in step, while a second route to undo is just undo
   * being reachable from a phone with no row to long-press — which is
   * exactly the case an empty plan is in.
   */
  global?: true;
}

export const ROW_MENU: MenuItem[] = [
  {
    id: "doing",
    label: "mark it doing",
    glyph: "⚑",
    // `s` cycles todo → doing → done, and `[ ]` only ever toggles the
    // two ends of that. Which means `doing` — the state a status meeting
    // is actually about — was the one value no mouse could set.
    actions: [{ cmd: "s", hint: "s" }],
    group: "state",
  },
  {
    id: "priority",
    label: "priority",
    glyph: "◆",
    actions: [
      { cmd: "gp", hint: "gp", side: "▲" },
      { cmd: "gP", hint: "gP", side: "▼" },
    ],
    group: "state",
  },
  {
    id: "progress",
    label: "progress",
    glyph: "%",
    actions: [
      { cmd: ")", hint: ")", side: "+" },
      { cmd: "(", hint: "(", side: "−" },
    ],
    group: "state",
  },
  {
    id: "nest",
    label: "nest / unnest",
    glyph: "⇥",
    actions: [
      { cmd: ">>", hint: ">>", side: "→" },
      { cmd: "<<", hint: "<<", side: "←" },
    ],
    group: "shape",
  },
  {
    id: "focus",
    label: "focus this subtree",
    glyph: "⌖",
    actions: [{ cmd: "zf", hint: "zf" }],
    group: "shape",
  },

  {
    id: "yank",
    label: "yank the row",
    glyph: "✂",
    actions: [{ cmd: "yy", hint: "yy" }],
    group: "edit",
  },
  {
    id: "put",
    label: "put it below",
    glyph: "⎘",
    actions: [{ cmd: "p", hint: "p" }],
    group: "edit",
  },
  {
    id: "undo",
    label: "undo",
    glyph: "↶",
    // Not about this row, and on the menu anyway: `u` is mouse-unreachable
    // like the rest, and the moment after a mis-click is exactly when
    // somebody driving with the mouse wants it and does not know the key.
    actions: [{ cmd: "u", hint: "u" }],
    global: true,
    group: "edit",
  },
  {
    id: "delete",
    label: "delete the row",
    glyph: "✖",
    // No confirmation, deliberately. `dd` has none either, `u` brings it
    // back, and right-click → move → click is already two acts of intent.
    // The status line says what went and how to undo it, which is the
    // same answer the keyboard gives.
    actions: [{ cmd: "dd", hint: "dd" }],
    group: "edit",
  },
];

/**
 * Everything a mouse can already do to a row, by the name its handler
 * uses. Kept here rather than in the components so the rule above has
 * something to be checked against.
 *
 * A gesture added to `TaskList` or `Gantt` belongs in this list, and
 * `check-rowmenu.ts` then fails if the menu still carries an item for
 * it — which is the point: the menu is supposed to lose entries as the
 * direct gestures grow.
 */
export const DIRECT_GESTURES: { gesture: string; cmd: string }[] = [
  { gesture: "click a row", cmd: "j" },
  { gesture: "click +", cmd: "o" },
  { gesture: "click [ ]", cmd: "<space>" },
  { gesture: "click ▾", cmd: "za" },
  { gesture: "double-click", cmd: "cc" },
  { gesture: "click the owner cell", cmd: "co" },
  { gesture: "click the note marker", cmd: "gn" },
  { gesture: "click a date cell", cmd: "cs" },
  { gesture: "drag a row", cmd: "J" },
  { gesture: "drag a bar", cmd: "." },
  { gesture: "drag the right edge", cmd: "+" },
  { gesture: "drag ● onto a bar", cmd: "D" },
  { gesture: "click a dependency arrow", cmd: "X" },
  { gesture: "drag the divider", cmd: ":split" },
];

/** Every command the menu would run, flattened. */
export function menuCommands(items: MenuItem[] = ROW_MENU): string[] {
  return items.flatMap((item) => item.actions.map((a) => a.cmd));
}
