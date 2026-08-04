/**
 * Theme handling.
 *
 * Three intents, not three colour schemes: `dark` is the neon HUD,
 * `light` is office mode — something you can have open in a meeting room
 * or paste into a status deck without it looking like a toy — and
 * `super` is the neon HUD with the brakes off, for the times the point
 * *is* that it looks like a toy.
 *
 * Super deliberately rides the same axis rather than being a second
 * switch beside it. Two switches would have a fourth combination —
 * office mode with the effects on — that has no meaning and no way to
 * look right, and every rule in `styles.css` would have to carry two
 * attributes to say so. One attribute, three values, and the base
 * `:root` block *is* the dark theme: `light` overrides it into office
 * mode, `super` overrides it upward. The consequence worth knowing is
 * that `gt` takes you out of super the way it takes you out of neon —
 * office mode is somewhere you go *to*, and it wins.
 *
 * The choice is applied to `<html data-theme>` and the tab title, and
 * remembered in localStorage, so it survives a reload and is picked up before React
 * renders (see `applyTheme` called from main.tsx) — otherwise the dark
 * theme flashes on every load for anyone who chose light.
 */

export type Theme = "dark" | "light" | "super";

export const THEMES: Theme[] = ["dark", "light", "super"];

const STORAGE_KEY = "yaiba:theme";

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // The tab is part of the surface office mode has to survive: it is
  // what a screen share puts on the wall, and the blade there needs the
  // same explaining it does in the corner of the HUD. Super says so in
  // the one place a tab has room to.
  document.title =
    theme === "light" ? "yaiba" : theme === "super" ? "yaiba 刃 SUPER" : "yaiba 刃";
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
 *
 * Super is remembered like the other two. It is loud, but it is loud
 * because somebody asked for it, and a mode that quietly reset itself
 * every morning would read as the setting not having worked.
 */
export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (THEMES.includes(saved as Theme)) return saved as Theme;
  } catch {
    /* unreadable storage — fall through to the OS preference */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}
