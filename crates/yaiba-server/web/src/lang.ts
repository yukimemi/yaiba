/**
 * Which language the UI is written in.
 *
 * English is the default rather than the browser's locale. `yaiba` is
 * read by people who did not install it, in screenshots and shared
 * screens, so what it says out of the box has to be the same
 * everywhere. Choosing `ja` is a choice, and it is remembered.
 *
 * What is *not* translated is anything you type: command names, key
 * names, `todo` / `doing` / `done`, tags. Translating those would make
 * the help a description of a different program from the one under
 * your fingers.
 *
 * Applied to `<html lang>` as well as stored, so a screen reader reads
 * the page in the language it is actually written in. The strings
 * themselves live in [`i18n.ts`](./i18n.ts); this module owns the
 * setting, and `applyLang` is the one place either copy of it is
 * written.
 */

import { setLang } from "./i18n";

export type Lang = "en" | "ja";

const STORAGE_KEY = "yaiba:lang";

export function applyLang(lang: Lang): void {
  setLang(lang);
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
