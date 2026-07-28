import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { addDays, isWeekend, monthLabel, parseISO, toISO, weekdays } from "../dates";
import type { Lang } from "../lang";

/** Six weeks, so the panel never changes height as you page months. */
const CELLS = 42;

/** Where the cell that opened this sits, in viewport coordinates. */
export interface Anchor {
  left: number;
  top: number;
  bottom: number;
}

interface Props {
  /** The date the cell currently holds, if any. */
  value: string | null;
  /** The reference date — highlighted, and where an empty cell opens. */
  today: string;
  /** Which language the column of weekday names is written in. */
  lang: Lang;
  anchor: Anchor;
  /** Column heading and hover text, repeated here so the panel says
   *  which of the four dates is being set. */
  label: string;
  hint: string;
  /** Offer `clear`. False for the plan's finish, which stores nothing. */
  clearable: boolean;
  onPick: (iso: string | null) => void;
  onClose: () => void;
}

function firstOfMonth(iso: string): string {
  const date = parseISO(iso);
  date.setDate(1);
  return toISO(date);
}

function shiftMonth(iso: string, months: number): string {
  const date = parseISO(iso);
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  return toISO(date);
}

/** The 6×7 block containing `iso`'s month, Sunday-first. */
function monthGrid(iso: string): string[] {
  const first = firstOfMonth(iso);
  const lead = parseISO(first).getDay();
  const from = addDays(first, -lead);
  return Array.from({ length: CELLS }, (_, i) => addDays(from, i));
}

/**
 * A month calendar, floating over the cell that opened it.
 *
 * Keyboard-first like everything else here: hjkl and the arrows walk the
 * grid, `[` / `]` page months, `t` jumps to the reference date, and
 * `<cr>` commits. The mouse is the second way in, not the only one — a
 * date you can *only* set by clicking would be the first thing in yaiba
 * that is.
 *
 * The panel owns every key while it is up, the way the project palette
 * does, so the task cursor cannot move behind it.
 */
export function DatePicker({
  value,
  today,
  lang,
  anchor,
  label,
  hint,
  clearable,
  onPick,
  onClose,
}: Props) {
  const panel = useRef<HTMLDivElement>(null);
  /** The day the keyboard is on — not a selection until <cr>. */
  const [cursor, setCursor] = useState(value ?? today);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 2 });

  // Measure, then keep the panel on screen. A cell near the bottom of a
  // long list would otherwise open a calendar mostly below the fold, and
  // one near the right edge would open it off the side.
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

  // Focus the panel itself rather than a day: the grid is driven by the
  // keys below, and moving focus cell to cell would fight the scroll of
  // the pane underneath.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  // Click anywhere else and the picker is finished with. Registered
  // after the pointerdown that opened it, so it cannot close on that one.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    // The app's own handler lives on `window`; stopping the event here
    // is what keeps `j` from moving the task cursor behind the panel.
    e.stopPropagation();
    const step: Record<string, number> = {
      h: -1,
      ArrowLeft: -1,
      l: 1,
      ArrowRight: 1,
      k: -7,
      ArrowUp: -7,
      j: 7,
      ArrowDown: 7,
    };
    if (e.key in step) {
      e.preventDefault();
      setCursor((c) => addDays(c, step[e.key]));
      return;
    }
    if (e.key === "[" || e.key === "PageUp") {
      e.preventDefault();
      setCursor((c) => shiftMonth(c, -1));
      return;
    }
    if (e.key === "]" || e.key === "PageDown") {
      e.preventDefault();
      setCursor((c) => shiftMonth(c, 1));
      return;
    }
    if (e.key === "t") {
      e.preventDefault();
      setCursor(today);
      return;
    }
    if (clearable && (e.key === "x" || e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      onPick(null);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onPick(cursor);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const month = firstOfMonth(cursor).slice(0, 7);

  return (
    <div
      className="datepick"
      ref={panel}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKey}
    >
      <div className="datepick__head">
        <button
          type="button"
          className="datepick__step"
          title="previous month — ["
          onClick={() => setCursor((c) => shiftMonth(c, -1))}
        >
          ‹
        </button>
        <span className="datepick__month">{monthLabel(cursor)}</span>
        <button
          type="button"
          className="datepick__step"
          title="next month — ]"
          onClick={() => setCursor((c) => shiftMonth(c, 1))}
        >
          ›
        </button>
        <span className="datepick__field">{label}</span>
      </div>

      <div className="datepick__grid">
        {weekdays(lang).map((day, i) => (
          <span
            key={day}
            className={`datepick__wd${i === 0 || i === 6 ? " datepick__wd--weekend" : ""}`}
          >
            {day}
          </span>
        ))}
        {monthGrid(cursor).map((iso) => (
          <button
            type="button"
            key={iso}
            className={[
              "datepick__day",
              iso.slice(0, 7) !== month && "datepick__day--outside",
              isWeekend(iso) && "datepick__day--weekend",
              iso === today && "datepick__day--today",
              iso === value && "datepick__day--set",
              iso === cursor && "datepick__day--cursor",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onPick(iso)}
          >
            {Number(iso.slice(8))}
          </button>
        ))}
      </div>

      <div className="datepick__foot">
        <button
          type="button"
          className="datepick__action"
          onClick={() => onPick(today)}
        >
          today
        </button>
        {clearable && (
          <button
            type="button"
            className="datepick__action"
            onClick={() => onPick(null)}
          >
            clear
          </button>
        )}
        {/* Its own title as well: the line is capped so a long one
            cannot stretch the panel wider than its grid, and a hint you
            can only read half of is not a hint. */}
        <span className="datepick__hint" title={hint}>
          {hint}
        </span>
      </div>
    </div>
  );
}
