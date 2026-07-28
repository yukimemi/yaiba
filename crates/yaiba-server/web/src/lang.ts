/**
 * Which language the calendar is written in.
 *
 * Only the weekday names have one — every other word in the UI is
 * English, and a date is the one place where a reader's own language
 * is faster than a shared one: `29土` is read as "the weekend" without
 * being spelled out.
 *
 * English is the default rather than the browser's locale. `yaiba` is
 * read by people who did not install it, in screenshots and shared
 * screens, so what it says out of the box has to be the same everywhere
 * — a UI that is English apart from three characters reads as a bug,
 * and the reader has no way to know it is a setting. Choosing `ja` is
 * therefore a choice, and it is remembered.
 *
 * Applied to `<html lang>` as well as stored, so a screen reader
 * announces the dates in the language they are actually written in.
 */

export type Lang = "en" | "ja";

const STORAGE_KEY = "yaiba:lang";

export function applyLang(lang: Lang): void {
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Private browsing, storage full, or a locked-down profile: the
    // choice still applies for this session, it just won't be remembered.
  }
}

/** Whatever was chosen last, else English. */
export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ja") return saved;
  } catch {
    /* unreadable storage — fall through to the default */
  }
  return "en";
}
