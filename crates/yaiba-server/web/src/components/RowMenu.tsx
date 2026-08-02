/**
 * The mouse's way to the keys that had no other one.
 *
 * What goes on it, and why it is a rule rather than a taste, is in
 * `rowMenu.ts`. This draws it and runs its keyboard, the way
 * `OwnerPicker` and `DatePicker` do: it owns every key while it is up,
 * `esc` hands the keyboard back, and the arrows plus `⏎` mean a pointing
 * device is never the only way to finish what a pointing device started.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ROW_MENU, type MenuAction } from "../rowMenu";
import { t } from "../i18n";

export interface RowMenuAt {
  /** The row the menu was opened on — already under the cursor. */
  id: string;
  /** Where the pointer was, in client coordinates. */
  x: number;
  y: number;
}

interface Props {
  at: RowMenuAt;
  onPick: (action: MenuAction) => void;
  onClose: () => void;
}

/** Flat list of the pickable actions, so ↑ / ↓ can walk them as one. */
const WALK = ROW_MENU.flatMap((item) =>
  item.actions.map((action) => ({ item, action })),
);

export function RowMenu({ at, onPick, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);
  const [box, setBox] = useState({ left: at.x, top: at.y });

  // Flip rather than overflow. A menu opened near the bottom of a short
  // window would otherwise hang off it, and this one is tall enough that
  // the last third of the rows go with it.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setBox({
      left: Math.max(4, Math.min(at.x, window.innerWidth - width - 4)),
      top: at.y + height > window.innerHeight ? Math.max(4, at.y - height) : at.y,
    });
  }, [at.x, at.y]);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  // A click anywhere else is a dismissal, which is what a context menu
  // has always meant by it. `pointerdown` rather than `click` so the
  // menu is gone before whatever was underneath reacts.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    // The app's handler is on `window` and is already declining to run
    // while this is up; stopping here as well keeps a stray `j` from
    // reaching anything at all.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    // Tab must not leave. The app declines every key while this is up, so
    // focus outside the panel is a keyboard that answers nothing — and it
    // was reachable: thirteen actions, and the fourteenth `Tab` landed on
    // `<body>` with no way back but the mouse. Given it has to be caught,
    // it may as well mean something, and walking the list is what `⇥`
    // does on the `:` line.
    if (e.key === "Tab") {
      e.preventDefault();
      setCursor((c) => (c + (e.shiftKey ? -1 : 1) + WALK.length) % WALK.length);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "j" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => (c + 1) % WALK.length);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "k" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => (c - 1 + WALK.length) % WALK.length);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick(WALK[cursor].action);
    }
  };

  let group = "";
  let walked = -1;

  return (
    <div
      ref={panel}
      className="rowmenu"
      role="menu"
      tabIndex={-1}
      // The panel keeps focus and the buttons never take it, so the
      // cursor moving under `j` / `k` / `⇥` is otherwise a CSS class and
      // nothing else — a screen reader is told the menu opened and then
      // hears silence as you walk it. `aria-activedescendant` is the
      // pattern the `menu` / `menuitem` roles above already promised;
      // declaring the roles and not wiring this is worse than declaring
      // neither.
      aria-activedescendant={`rowmenu-action-${cursor}`}
      onKeyDown={onKey}
      // The invariant behind the `Tab` trap above, stated once rather
      // than defended key by key: this panel makes the app decline every
      // keystroke, so focus leaving it *must* close it. Trapping `Tab`
      // fixes the route that was reachable; this fixes the ones nobody
      // has thought of yet — and a menu that outlives the window's focus
      // is what every other context menu closes on anyway.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
      style={{ left: box.left, top: box.top }}
      // The pointer opened this; it must not also close it on the way in.
      onContextMenu={(e) => e.preventDefault()}
    >
      {ROW_MENU.map((item) => {
        const rule = group && group !== item.group;
        group = item.group;
        return (
          <div key={item.id}>
            {rule ? <div className="rowmenu__rule" /> : null}
            <div className="rowmenu__row">
              <span className="rowmenu__glyph" aria-hidden="true">
                {item.glyph}
              </span>
              <span className="rowmenu__label">{t(item.label)}</span>
              <span className="rowmenu__actions">
                {item.actions.map((action) => {
                  walked += 1;
                  const at = walked;
                  return (
                    <button
                      key={action.cmd}
                      // Indexed by the walk order, so the id the panel
                      // points at is the item the highlight is on — one
                      // counter for both, rather than two that can drift.
                      id={`rowmenu-action-${at}`}
                      type="button"
                      role="menuitem"
                      className={`rowmenu__action${
                        cursor === at ? " rowmenu__action--on" : ""
                      }`}
                      onPointerEnter={() => setCursor(at)}
                      onClick={() => onPick(action)}
                    >
                      {action.side ? (
                        <span className="rowmenu__side">{action.side}</span>
                      ) : null}
                      <span className="rowmenu__hint">{action.hint}</span>
                    </button>
                  );
                })}
              </span>
            </div>
          </div>
        );
      })}
      <div className="rowmenu__rule" />
      {/* There is no API to *open* the browser's own menu, so the only
          way to offer it is to decline the event — which is what shift
          does on the row. Said here because a menu that took the right
          button without saying how to get it back would be the rudest
          thing in the app. */}
      <div className="rowmenu__foot">
        <span>⇧ {t("right-click")}</span>
        <span>{t("the browser's own menu")}</span>
      </div>
    </div>
  );
}
