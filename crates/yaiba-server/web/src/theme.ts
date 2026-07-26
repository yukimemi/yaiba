/**
 * Theme handling.
 *
 * Two intents, not two colour schemes: `dark` is the neon HUD, `light`
 * is office mode — something you can have open in a meeting room or
 * paste into a status deck without it looking like a toy.
 *
 * The choice is applied to `<html data-theme>` and the tab title, and
 * remembered in localStorage, so it survives a reload and is picked up before React
 * renders (see `applyTheme` called from main.tsx) — otherwise the dark
 * theme flashes on every load for anyone who chose light.
 */

export type Theme = "dark" | "light";

const STORAGE_KEY = "yaiba:theme";

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // The tab is part of the surface office mode has to survive: it is
  // what a screen share puts on the wall, and the blade there needs the
  // same explaining it does in the corner of the HUD.
  document.title = theme === "light" ? "yaiba" : "yaiba 刃";
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private browsing, storage full, or a locked-down profile: the
    // theme still applies for this session, it just won't be remembered.
  }
}

/**
 * The theme to start in: whatever was chosen last, else the OS
 * preference, else dark.
 */
export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* unreadable storage — fall through to the OS preference */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}
