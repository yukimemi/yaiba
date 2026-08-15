/**
 * Date helpers. Everything crossing the wire is an ISO `YYYY-MM-DD`
 * string; `Date` objects only exist inside these functions, and always
 * at local noon so that adding days can never trip over a DST boundary
 * and land on the previous day.
 */

import type { Lang } from "./lang";
import type { Calendar } from "./types";

export function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function toISO(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const date = parseISO(iso);
  date.setDate(date.getDate() + days);
  return toISO(date);
}

/** Whole days from `a` to `b`; negative when `b` precedes `a`. */
export function diffDays(a: string, b: string): number {
  const ms = parseISO(b).getTime() - parseISO(a).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * Is `day` — a `Date.getDay()`, Sunday first — outside the work week?
 *
 * `Calendar.week` is **Monday** first, because that is how the server
 * stores it and how a work week is read. `getDay()` is Sunday first.
 * This shift is the only place the two orders meet, and it is a
 * function rather than an inline `(d + 6) % 7` for exactly that reason:
 * the classic way to get this wrong is to index `week` with a raw
 * `getDay()` in a second place and be one day out for everybody whose
 * week is not Monday to Friday.
 *
 * A mask that is not seven long, or that has no working day in it at
 * all, is treated as no opinion rather than as "never work". A peer can
 * sync a broken value, and the honest failure there is a calendar that
 * says nothing — the alternative is a plan with nowhere to put any of
 * its tasks. The server degrades the same way.
 */
export function isOffWeekday(day: number, cal: Calendar): boolean {
  if (cal.week.length !== 7 || !cal.week.some(Boolean)) return false;
  return !cal.week[(day + 6) % 7];
}

/**
 * Is this a day nobody works — a weekend, a holiday, or a day somebody
 * marked off?
 *
 * The server's `Calendar::is_working`, negated, and true in **both**
 * modes: `mode` decides whether the scheduler counts these days, not
 * whether they are shaded. Precedence is the server's — an explicit
 * working day wins over a holiday, a holiday wins over the week mask —
 * because both sides are reading the same three fields and disagreeing
 * about the order would paint bars onto days the scheduler skipped.
 *
 * Outside the resolved window (see `Calendar.holidays`) only the week
 * mask is known here, so a holiday years out reads as a working day.
 * The scheduler is not fooled — it resolves the real table server-side
 * — which is why this is a shading limit rather than a planning one.
 *
 * `workdays` is scanned rather than indexed: it holds hand-marked days,
 * so it is empty on almost every plan and a Set per render would cost
 * more than the scan it saves.
 */
export function isOffDay(iso: string, cal: Calendar): boolean {
  if (cal.workdays.includes(iso)) return false;
  if (iso in cal.holidays) return true;
  return isOffWeekday(parseISO(iso).getDay(), cal);
}

/**
 * What to call this day off, or null when it has no name.
 *
 * A weekend has none, and neither does a day marked off without one:
 * `""` is stored for those, and a tooltip reading nothing is worse
 * than no tooltip.
 */
export function holidayName(iso: string, cal: Calendar): string | null {
  if (cal.workdays.includes(iso)) return null;
  return cal.holidays[iso] || null;
}

/**
 * Calendar days one walk may cover before it gives up and saturates.
 *
 * **This is the server's `MAX_WALK`, and it has to be the same number.**
 * `check-cal.ts` reads the constant out of `calendar.rs` and fails the
 * build if the two drift, because a browser that stops earlier than the
 * scheduler is a preview that disagrees with the commit — the one rule
 * this whole feature leans on. It was two numbers here (400 for the snap,
 * 36,500 for a count) and both were smaller than the server's, so an
 * oversized `duration_days` could stop the preview 3,500 days short of
 * where the bar actually lands, and a run of more than 400 marked
 * holidays could stop a snap early with nothing on screen saying so.
 *
 * Reached only by absurd input: nothing anybody types walks a century,
 * and the week mask cannot stall a walk because a mask with no working
 * day degrades to "no opinion" above. Saturating rather than looping is
 * the same bargain the server makes — a wrong date is recoverable, a
 * frozen tab is not.
 *
 * Exported for the parity check and for nothing else.
 */
export const MAX_WALK = 40_000;

/**
 * The first working day at or after `iso` — `Calendar::snap_forward`.
 *
 * `days` mode returns the date untouched, and every function below
 * degrades the same way. That is the whole reason these take a
 * `Calendar` rather than a mode flag: no caller writes `if (mode)`, so
 * no caller can forget to.
 */
export function snapForward(iso: string, cal: Calendar): string {
  return snap(iso, cal, 1);
}

/** The last working day at or before `iso` — `Calendar::snap_back`. */
export function snapBack(iso: string, cal: Calendar): string {
  return snap(iso, cal, -1);
}

/**
 * The nearest working day in the direction of travel.
 *
 * The direction is the whole of the difference between the two snaps,
 * and it is threaded through every function below rather than being
 * decided once at the top: a walk that snaps forward and then steps
 * backwards lands a day out whenever it starts on a day nobody works.
 * The server had exactly that bug and it was invisible until the round
 * trip was checked from a Saturday.
 */
function snap(iso: string, cal: Calendar, dir: 1 | -1): string {
  if (cal.mode === "days") return iso;
  let cursor = iso;
  for (let scanned = 0; scanned < MAX_WALK && isOffDay(cursor, cal); scanned++) {
    cursor = addDays(cursor, dir);
  }
  return cursor;
}

/**
 * `n` working days from `iso` — `Calendar::advance`, which is also
 * `retreat` seen from the other end when `n` is negative.
 *
 * `advanceWork(d, 0)` is `snapForward(d)`, so a one-day task starting
 * on a Saturday finishes on the Monday. Backwards, the anchor is
 * `snapBack`: both ends of a walk snap the way the walk is going, which
 * is what makes the round trip below hold from any day rather than only
 * from a working one.
 */
export function advanceWork(iso: string, n: number, cal: Calendar): string {
  if (cal.mode === "days") return addDays(iso, n);
  const dir = n < 0 ? -1 : 1;
  let cursor = snap(iso, cal, dir);
  let left = Math.abs(n);
  // Bounded by the calendar days *walked in total*, not by the days
  // walked looking for each next one. A per-step cap leaves the whole
  // walk unbounded, and `n` here is not small by construction:
  // `duration_days` has never been bounded anywhere (a peer or the API
  // can set it to anything, which is why the server saturates rather
  // than trusting it), and the count typed in front of `.` is whatever
  // the fingers said. Unbounded, `999999999.` freezes the tab.
  //
  // `Calendar::walk` on the server counts exactly this way and saturates
  // at the same kind of ceiling, so the preview and the commit agree even
  // on the absurd input neither of them can place.
  let walked = 0;
  while (left > 0 && walked < MAX_WALK) {
    walked++;
    cursor = addDays(cursor, dir);
    if (!isOffDay(cursor, cal)) left--;
  }
  return cursor;
}

/**
 * Working days from `from` to `to` — `Calendar::count`, and the inverse
 * of `advanceWork` in whichever direction it is asked:
 *
 * - `to >= from` → `advanceWork(d, countWork(d, x))` is `snapForward(x)`
 * - `to < from`  → `advanceWork(d, countWork(d, x))` is `snapBack(x)`
 *
 * Two lines rather than one because a day off has two nearest working
 * days and the answer depends on which way you were walking. Which way
 * is decided from the dates as given, before either is snapped — a
 * weekend that snaps forward past `from` would otherwise turn a step
 * back into a step forward.
 *
 * The one place the second line stops: a count of zero. Nothing is
 * walked, and `advanceWork(d, 0)` snaps *forward* by definition — a
 * one-day task starting on a Saturday has to finish on the Monday.
 * Two days that snap back to the same working day therefore count 0
 * and land forwards. The server's `count` and `advance` do exactly the
 * same thing at zero, and this is a mirror of them rather than a
 * second opinion.
 *
 * Negative when `to` precedes `from`, so it reads as `diffDays` does —
 * and *is* `diffDays` in `days` mode, which is what keeps `:end` and a
 * pinned lag computing the numbers they always have.
 *
 * Counted a day at a time rather than by weeks-times-mask arithmetic:
 * the marks and the holiday table punch holes in any closed form, and
 * the spans this is asked about are a plan wide. It runs on a commit
 * and on a drag preview, not on every row of every frame.
 */
export function countWork(from: string, to: string, cal: Calendar): number {
  if (cal.mode === "days") return diffDays(from, to);
  return to < from ? -steps(from, to, cal, -1) : steps(from, to, cal, 1);
}

/** Working days strictly between the two snapped ends, `to` included. */
function steps(from: string, to: string, cal: Calendar, dir: 1 | -1): number {
  const target = snap(to, cal, dir);
  let cursor = snap(from, cal, dir);
  // Bounded by the span itself — the loop cannot outrun the two dates —
  // and then by a century, so a date typed with an extra digit costs a
  // frame rather than the tab.
  const span = Math.min(Math.abs(diffDays(cursor, target)), MAX_WALK);
  let n = 0;
  for (let i = 0; i < span; i++) {
    cursor = addDays(cursor, dir);
    if (!isOffDay(cursor, cal)) n++;
  }
  return n;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Sunday first, indexed by `Date.getDay()` — and by the calendar grid.
 *
 * Two characters wide in either language: a day column in the gantt
 * header is 26px and the day number sits beside the name. One letter
 * would fit better and be unreadable — `T` is Tuesday and Thursday.
 */
const WEEKDAY_LABELS: Record<Lang, string[]> = {
  en: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
  ja: ["日", "月", "火", "水", "木", "金", "土"],
};

/** All seven in order, for anything drawing a calendar grid. */
export function weekdays(lang: Lang): string[] {
  return WEEKDAY_LABELS[lang];
}

export function weekdayLabel(iso: string, lang: Lang): string {
  return WEEKDAY_LABELS[lang][parseISO(iso).getDay()];
}

export function monthLabel(iso: string): string {
  const date = parseISO(iso);
  return `${date.getFullYear()}/${date.getMonth() + 1}`;
}

/** `2026-08-04` → `08/04`. */
export function shortLabel(iso: string): string {
  return iso.slice(5).replace("-", "/");
}

/**
 * Parse the date expressions accepted on the `:` command line.
 *
 * Supported: `today` / `tod`, `tomorrow` / `tom`, `yesterday`,
 * weekday names (`mon`…`sun`, next occurrence), relative offsets
 * (`+3d`, `-1w`, `+2m`), `YYYY-MM-DD`, `MM-DD` / `MM/DD` (this year,
 * rolling into next year if already past), and a bare day-of-month.
 * Returns `null` when nothing matches, so callers can report a parse
 * error instead of silently writing a wrong date.
 */
export function parseDateExpr(input: string, today: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "none" || raw === "clear" || raw === "-") return null;

  if (raw === "today" || raw === "tod") return today;
  if (raw === "tomorrow" || raw === "tom") return addDays(today, 1);
  if (raw === "yesterday" || raw === "yes") return addDays(today, -1);

  const relative = raw.match(/^([+-])(\d+)([dwmy])?$/);
  if (relative) {
    const sign = relative[1] === "-" ? -1 : 1;
    const n = Number(relative[2]) * sign;
    switch (relative[3] ?? "d") {
      case "d":
        return addDays(today, n);
      case "w":
        return addDays(today, n * 7);
      case "m": {
        const date = parseISO(today);
        date.setMonth(date.getMonth() + n);
        return toISO(date);
      }
      case "y": {
        const date = parseISO(today);
        date.setFullYear(date.getFullYear() + n);
        return toISO(date);
      }
    }
  }

  const weekday = WEEKDAYS.indexOf(raw.slice(0, 3));
  if (weekday >= 0 && raw.length <= 9) {
    const current = parseISO(today).getDay();
    // Always the *next* occurrence: naming today's weekday means a
    // week out, which is what "push this to monday" usually means.
    const ahead = (weekday - current + 7) % 7 || 7;
    return addDays(today, ahead);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const monthDay = raw.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (monthDay) {
    const year = parseISO(today).getFullYear();
    const m = `${monthDay[1]}`.padStart(2, "0");
    const d = `${monthDay[2]}`.padStart(2, "0");
    const candidate = `${year}-${m}-${d}`;
    return candidate < today ? `${year + 1}-${m}-${d}` : candidate;
  }

  const dayOnly = raw.match(/^(\d{1,2})$/);
  if (dayOnly) {
    const date = parseISO(today);
    const day = Number(dayOnly[1]);
    date.setDate(day);
    const candidate = toISO(date);
    if (candidate < today) {
      date.setMonth(date.getMonth() + 1);
      return toISO(date);
    }
    return candidate;
  }

  return null;
}
