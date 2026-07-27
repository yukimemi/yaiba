/**
 * Date helpers. Everything crossing the wire is an ISO `YYYY-MM-DD`
 * string; `Date` objects only exist inside these functions, and always
 * at local noon so that adding days can never trip over a DST boundary
 * and land on the previous day.
 */

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

export function isWeekend(iso: string): boolean {
  const day = parseISO(iso).getDay();
  return day === 0 || day === 6;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Sunday first, indexed by `Date.getDay()` — and by the calendar grid. */
export const JP_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function weekdayLabel(iso: string): string {
  return JP_WEEKDAYS[parseISO(iso).getDay()];
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
