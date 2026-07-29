import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { t } from "../i18n";

import type { Anchor } from "./DatePicker";

interface Props {
  /** The name the cell currently holds; `""` when nobody owns the task. */
  value: string;
  /**
   * Every name already in use, which is the whole vocabulary there is —
   * see `assigneeNames`. Offering it is the point of the panel: a name
   * typed from scratch each time is how `Yuki` and `yuki` become two
   * people, and the mouse has no `tab` to lean on.
   */
  names: string[];
  anchor: Anchor;
  /** `null` clears the field. */
  onPick: (name: string | null) => void;
  onClose: () => void;
}

/**
 * Who owns this task, floating over the `owner` cell that opened it.
 *
 * The mouse's way into a field that until now only `:assign` could
 * reach. It is deliberately *not* a bare text box: the store keeps names
 * verbatim and there is no roster behind them, so the only thing holding
 * a team to one spelling is seeing the spellings that already exist.
 * `tab` does that on the command line; this list does it here.
 *
 * Nothing is validated in this file. `:assign` already refuses a name
 * with a space in it, and the panel commits by running that command, so
 * a second opinion here would be the one that goes stale — the same
 * bargain `commitDate` makes with the four date commands. The foot says
 * "one word" so the rule is visible before it is hit, which is a hint,
 * not a copy of the check.
 */
export function OwnerPicker({ value, names, anchor, onPick, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  /** Index into `shown`, or -1 for "commit what is typed". */
  const [at, setAt] = useState(-1);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 2 });

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return names;
    return names.filter((n) => n.toLowerCase().includes(needle));
  }, [names, query]);

  // Same clamp the calendar uses: a cell low in a long list would open a
  // panel mostly below the fold, and one near the right edge off the side.
  useLayoutEffect(() => {
    const box = panel.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(
      8,
      Math.min(anchor.left, window.innerWidth - box.width - 8),
    );
    const below = anchor.bottom + 2;
    const top =
      below + box.height > window.innerHeight - 8
        ? Math.max(8, anchor.top - box.height - 2)
        : below;
    setPos({ left, top });
  }, [anchor.left, anchor.top, anchor.bottom]);

  // The input, not the panel: typing a name is the primary act here,
  // where the calendar's is walking a grid.
  useEffect(() => {
    input.current?.focus();
  }, []);

  // Click anywhere else and the panel is finished with. Registered after
  // the pointerdown that opened it, so it cannot close on that one.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  // A highlight pointing past the end of a list the query just shortened
  // would commit nothing on <cr> and read as the panel ignoring you.
  useEffect(() => {
    setAt((current) => (current >= shown.length ? shown.length - 1 : current));
  }, [shown.length]);

  const typed = query.trim();

  const onKey = (e: React.KeyboardEvent) => {
    // The app's handler lives on `window`; stopping it here is what keeps
    // `j` from moving the task cursor behind the panel.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setAt((c) => Math.min(c + 1, shown.length - 1));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      // Off the top is the typed text again, so walking back gives you
      // what you wrote rather than stranding you on a candidate.
      setAt((c) => Math.max(c - 1, -1));
      return;
    }
    // An empty box is the only place these clear the field. Anywhere else
    // they are editing the text, and `x` — which is what the calendar
    // uses — is a letter that belongs to a name here.
    if ((e.key === "Backspace" || e.key === "Delete") && !query) {
      e.preventDefault();
      onPick(null);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // The highlight wins when there is one; otherwise what was typed.
      // Nothing typed and nothing highlighted commits *nothing* — it does
      // not clear. Enter is the key you press to dismiss a box you opened
      // by accident, and having that silently unassign the row would be a
      // trap. Clearing says so out loud: the button, `x` on an empty box,
      // or bare `:assign`.
      if (at >= 0 && shown[at]) onPick(shown[at]);
      else if (typed) onPick(typed);
      else onClose();
    }
  };

  return (
    <div
      className="ownerpick"
      ref={panel}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKey}
    >
      <div className="ownerpick__head">
        <span className="ownerpick__field">{t("owner")}</span>
        {value && <span className="ownerpick__current">@{value}</span>}
      </div>

      <input
        className="ownerpick__input"
        ref={input}
        value={query}
        spellCheck={false}
        placeholder={t("filter, or a name that is new")}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(-1);
        }}
      />

      {shown.length > 0 && (
        <ul className="ownerpick__list">
          {shown.map((name, index) => (
            <li key={name}>
              <button
                type="button"
                className={[
                  "ownerpick__item",
                  index === at && "ownerpick__item--on",
                  name === value && "ownerpick__item--set",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onPick(name)}
              >
                @{name}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="ownerpick__foot">
        {/* Only when there is something to take away. On an unowned row
            the button would do nothing and still look like it might. */}
        {value && (
          <button
            type="button"
            className="ownerpick__action"
            onClick={() => onPick(null)}
          >
            {t("clear")}
          </button>
        )}
        {typed && !names.some((n) => n.toLowerCase() === typed.toLowerCase()) && (
          <button
            type="button"
            className="ownerpick__action ownerpick__action--new"
            onClick={() => onPick(typed)}
          >
            {t("add @{name}", { name: typed })}
          </button>
        )}
        <span className="ownerpick__hint">
          {t("one word · ⏎ commit · ⌫ clear · esc close")}
        </span>
      </div>
    </div>
  );
}
