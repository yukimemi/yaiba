import type { View } from "../commands";
import { t } from "../i18n";

interface Props {
  /**
   * The pane actually on screen, so `<tab>` can be labelled with the one
   * it switches *to*. Narrow is one pane at a time, and a button that
   * said "pane" would be the only one on the bar that does not say where
   * it goes.
   */
  shownView: View;
  /** A key, run through the command layer. Never an action of its own. */
  onRun: (cmd: string) => void;
}

/**
 * The keys a phone cannot type, as eight buttons along the bottom.
 *
 * Every one of them **is** a key — the bar hands `runKey` a command
 * string and nothing else, the bargain the row menu already makes. So a
 * refusal (`:asof` locking writes, an undo with nothing behind it)
 * happens once, in the place it always did, and this file can never
 * drift from what the keyboard does.
 *
 * What it holds is decided by the same kind of rule as the row menu's,
 * pointing the other way: **global actions only**. `o`, `<tab>`, `[`,
 * `]`, `gd`, `:`, `u`, `T` are the eight that act on the app rather than
 * on a row. A per-row action here would make the row menu's entry for it
 * redundant — the menu exists exactly for what the pointer cannot
 * already reach — and `check-rowmenu.ts` fails the build for it.
 *
 * Unlike the row menu the faces are words, not keys. The menu teaches
 * the keyboard because it opens on a machine that has one; this opens
 * where there is no keyboard to teach, so printing `gd` on a button
 * would spend the ~48px it has on a hint nobody can use. The key is
 * still on the element as `data-cmd`, which is the whole of what the
 * button knows how to do and the thing to read when one misbehaves.
 */
export function TouchBar({ shownView, onRun }: Props) {
  // Built per render rather than hoisted, because `t` answers in
  // whatever language is current and `:lang` has to change these eight
  // words with the rest of the UI.
  const keys: { cmd: string; label: string }[] = [
    { cmd: "o", label: t("new task") },
    { cmd: "<tab>", label: shownView === "gantt" ? t("list") : t("gantt") },
    { cmd: "[", label: t("zoom out") },
    { cmd: "]", label: t("zoom in") },
    { cmd: "gd", label: t("dates") },
    { cmd: ":", label: t("command") },
    { cmd: "u", label: t("undo") },
    { cmd: "T", label: t("today") },
  ];

  return (
    <nav className="touchbar" aria-label={t("actions")}>
      {keys.map(({ cmd, label }) => (
        <button
          key={cmd}
          type="button"
          className="touchbar__key"
          data-cmd={cmd}
          // Refuse the focus rather than take it and give it back. The
          // app's keyboard handler lives on `window` and preventDefaults
          // every bare key, so a button holding focus is one that eats
          // `enter` and `space` without ever firing its own click — the
          // dead-keyboard trap `RowMenu` documents, arrived at from the
          // other side. Blurring in `onClick` would also work, but it
          // runs *after* `runKey`, so `:` and `o` — the two that focus an
          // input of their own — would be racing it. Nothing here needs
          // focus: `tab` never reaches the bar either, because the app
          // normalises it to `<tab>`.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onRun(cmd)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
