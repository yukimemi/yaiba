/**
 * Theme handling, and the palette under it.
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
 *
 * ---- the palette --------------------------------------------------
 *
 * What a user may change is the *value* of each named colour, never
 * which colour means what. `styles.css` opens with the rule — cyan is
 * the blade, magenta is the critical path and nothing else, amber is
 * overdue — and that rule is about meaning, not about hue: somebody who
 * wants gruvbox's pink for the critical path still has exactly one
 * colour that means critical path. So the unit of customisation is the
 * *slot*, and there is no way to write arbitrary CSS.
 *
 * Two things deliberately stay out of reach:
 *
 * - **`--glow`.** It is the whole of office mode (every shadow is
 *   `calc(Npx * var(--glow))`), so a palette able to set it could light
 *   the neon back up in the one mode whose job is surviving a shared
 *   screen. `gs` is where loudness lives.
 * - **Layout.** `--row-h`, `--gutter`, the pane metrics and `--mono` are
 *   not colours and are not here.
 *
 * Overrides are stored per *ground* rather than per theme, because that
 * is how the stylesheet is built: `:root` carries the neon colours that
 * `dark` and `super` share, and `:root[data-theme="light"]` replaces
 * them for office mode. Keeping the two apart is also the only honest
 * answer to the alpha trap documented in AGENTS.md — a fill mixed for a
 * near-black background washes out to nothing over white, so one palette
 * spanning both grounds would always be wrong for one of them.
 */

export type Theme = "dark" | "light" | "super";

export const THEMES: Theme[] = ["dark", "light", "super"];

/**
 * Which of the stylesheet's two colour blocks a theme reads.
 *
 * `super` is not a third ground: it turns the glow up and adds a section
 * of animations, and takes its hues from the same `:root` block `dark`
 * does. Anything that looks like a third ground here is a sign somebody
 * has started a second stylesheet.
 */
export type Ground = "neon" | "office";

export const GROUNDS: Ground[] = ["neon", "office"];

export function ground(theme: Theme): Ground {
  return theme === "light" ? "office" : "neon";
}

/**
 * A theme that shows `on`, given where you are now.
 *
 * The settings panel edits one ground at a time and switches to it, on
 * the grounds that editing colours you cannot see is not editing. Coming
 * back to neon from office lands on `dark`; already being in `super`
 * keeps `super`, because the tab is a question about hues and `gs` is
 * the one about loudness.
 */
export function themeFor(on: Ground, current: Theme): Theme {
  if (on === "office") return "light";
  return current === "light" ? "dark" : current;
}

/**
 * The colour slots, in the order the panel lists them: the grounds
 * first, then the four signals, then the three weights of text.
 *
 * The names are the CSS custom properties without their dashes, so
 * `check-theme.ts` can hold this list and `:root` to each other — a slot
 * named here with no declaration behind it would render as a control
 * that does nothing.
 */
export type Slot =
  | "void"
  | "panel"
  | "grid"
  | "grid-strong"
  | "edge"
  | "edge-dim"
  | "blood"
  | "rust"
  | "jade"
  | "steel"
  | "ash"
  | "ash-dim";

/**
 * A slot and what it means, in English for `t()`.
 *
 * The label says what the colour *does*, not what it currently is:
 * "critical path" stays true after somebody has made it green, and
 * "magenta" would not. `check-i18n.mjs` reads these `label:` lines out of
 * this file the way it reads the row menu's, since nothing here is a
 * literal at a call site.
 */
export interface SlotSpec {
  slot: Slot;
  label: string;
}

export const SLOTS: SlotSpec[] = [
  { slot: "void", label: "background" },
  { slot: "panel", label: "panels, the bar, popovers" },
  { slot: "grid", label: "grid lines" },
  { slot: "grid-strong", label: "grid lines, the stronger ones" },
  { slot: "edge", label: "the blade — cursor, focus, structure" },
  { slot: "edge-dim", label: "the blade, quieter — rails and edges" },
  { slot: "blood", label: "the critical path, and nothing else" },
  { slot: "rust", label: "overdue, and nothing else" },
  { slot: "jade", label: "done, and progress" },
  { slot: "steel", label: "text" },
  { slot: "ash", label: "text, quieter" },
  { slot: "ash-dim", label: "text and marks, quietest" },
];

/** A slot's colour, or nothing where the stylesheet's own is kept. */
export type Palette = Partial<Record<Slot, string>>;

export type Palettes = Record<Ground, Palette>;

export const NO_PALETTES: Palettes = { neon: {}, office: {} };

/**
 * A named set of colours for one ground.
 *
 * `colors: null` is the stylesheet's own palette — "yaiba", the entry
 * that clears every override. It is deliberately not a copy of the hexes
 * in `styles.css`: a copy is a second place for them to be right, and
 * `check-theme.ts` refuses one.
 *
 * The names are the schemes the hues come from rather than a claim to be
 * those schemes: each one is fitted to yaiba's twelve slots, which means
 * picking greys that carry three weights of text and keeping the four
 * signals apart from each other.
 */
export interface Preset {
  name: string;
  ground: Ground;
  colors: Record<Slot, string> | null;
}

export const PRESETS: Preset[] = [
  { name: "yaiba", ground: "neon", colors: null },
  {
    name: "gruvbox",
    ground: "neon",
    colors: {
      void: "#1d2021",
      panel: "#282828",
      grid: "#32302f",
      "grid-strong": "#504945",
      edge: "#83a598",
      "edge-dim": "#458588",
      blood: "#d3869b",
      rust: "#fabd2f",
      jade: "#b8bb26",
      steel: "#ebdbb2",
      ash: "#a89984",
      "ash-dim": "#665c54",
    },
  },
  {
    name: "nord",
    ground: "neon",
    colors: {
      void: "#2e3440",
      panel: "#3b4252",
      grid: "#434c5e",
      "grid-strong": "#4c566a",
      edge: "#88c0d0",
      "edge-dim": "#5e81ac",
      blood: "#b48ead",
      rust: "#ebcb8b",
      jade: "#a3be8c",
      steel: "#eceff4",
      ash: "#8d97a8",
      "ash-dim": "#5b657a",
    },
  },
  {
    name: "dracula",
    ground: "neon",
    colors: {
      void: "#282a36",
      panel: "#21222c",
      grid: "#343746",
      "grid-strong": "#44475a",
      edge: "#8be9fd",
      "edge-dim": "#6272a4",
      blood: "#ff79c6",
      rust: "#ffb86c",
      jade: "#50fa7b",
      steel: "#f8f8f2",
      ash: "#9ea3bb",
      "ash-dim": "#565a71",
    },
  },
  {
    name: "tokyo",
    ground: "neon",
    colors: {
      void: "#1a1b26",
      panel: "#16161e",
      grid: "#22242e",
      "grid-strong": "#2f3549",
      edge: "#7dcfff",
      "edge-dim": "#3d59a1",
      blood: "#bb9af7",
      rust: "#e0af68",
      jade: "#9ece6a",
      steel: "#c0caf5",
      ash: "#7f87ab",
      "ash-dim": "#545c7e",
    },
  },
  { name: "yaiba", ground: "office", colors: null },
  {
    name: "solarized",
    ground: "office",
    colors: {
      void: "#fdf6e3",
      panel: "#eee8d5",
      grid: "#e6dfca",
      "grid-strong": "#d3cbb7",
      edge: "#268bd2",
      "edge-dim": "#6c9bc0",
      blood: "#d33682",
      rust: "#b58900",
      jade: "#859900",
      steel: "#073642",
      ash: "#657b83",
      "ash-dim": "#93a1a1",
    },
  },
  {
    name: "gruvbox light",
    ground: "office",
    colors: {
      void: "#fbf1c7",
      panel: "#f2e5bc",
      grid: "#ecdfb2",
      "grid-strong": "#d5c4a1",
      edge: "#076678",
      "edge-dim": "#458588",
      blood: "#b16286",
      rust: "#b57614",
      jade: "#79740e",
      steel: "#3c3836",
      ash: "#7c6f64",
      "ash-dim": "#a89984",
    },
  },
];

/**
 * `#rgb` or `#rrggbb`, and nothing else.
 *
 * Not a nicety: these strings are written straight into a custom property
 * with `setProperty`, and a palette restored from localStorage is input
 * like any other. Hex is also the one notation both halves of the panel
 * speak — `<input type="color">` reads and writes exactly this.
 */
export function isHex(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

const THEME_KEY = "yaiba:theme";
const PALETTE_KEY = "yaiba:palette";

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // The tab is part of the surface office mode has to survive: it is
  // what a screen share puts on the wall, and the blade there needs the
  // same explaining it does in the corner of the HUD. Super says so in
  // the one place a tab has room to.
  document.title =
    theme === "light" ? "yaiba" : theme === "super" ? "yaiba 刃 SUPER" : "yaiba 刃";
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private browsing, storage full, or a locked-down profile: the
    // theme still applies for this session, it just won't be remembered.
  }
}

/**
 * Write the active ground's overrides onto `<html>`, and take the other
 * ground's off.
 *
 * Inline custom properties outrank every selector in the stylesheet,
 * including `:root[data-theme="light"]`, which is exactly why only one
 * ground's may be on the element at a time — office mode's own colours
 * are a *rule*, and a leftover neon `--void` would beat it. So this
 * removes as deliberately as it sets, and has to run on every theme
 * change as well as every palette edit.
 */
export function applyPalette(theme: Theme, palettes: Palettes): void {
  const palette = palettes[ground(theme)];
  const style = document.documentElement.style;
  for (const { slot } of SLOTS) {
    const hex = palette[slot];
    if (hex && isHex(hex)) style.setProperty(`--${slot}`, hex);
    else style.removeProperty(`--${slot}`);
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
    const saved = localStorage.getItem(THEME_KEY);
    if (THEMES.includes(saved as Theme)) return saved as Theme;
  } catch {
    /* unreadable storage — fall through to the OS preference */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/**
 * The saved palettes, with anything unrecognisable dropped.
 *
 * Field by field rather than all-or-nothing, the same bargain
 * `initialViewState` makes: a blob written by another version — a slot
 * that has since been renamed, a colour typed in a notation this one
 * does not take — degrades to the stylesheet's own value for that one
 * slot instead of throwing the whole palette away.
 */
export function loadPalettes(): Palettes {
  try {
    const saved = localStorage.getItem(PALETTE_KEY);
    if (!saved) return NO_PALETTES;
    const parsed = JSON.parse(saved) as Partial<Record<Ground, unknown>>;
    const out: Palettes = { neon: {}, office: {} };
    for (const on of GROUNDS) {
      const raw = parsed[on];
      if (!raw || typeof raw !== "object") continue;
      for (const { slot } of SLOTS) {
        const hex = (raw as Record<string, unknown>)[slot];
        if (typeof hex === "string" && isHex(hex)) out[on][slot] = hex.toLowerCase();
      }
    }
    return out;
  } catch {
    // Unreadable storage or unparseable JSON — the stylesheet's own
    // colours, which is what somebody who has never opened the panel has.
    return NO_PALETTES;
  }
}

export function savePalettes(palettes: Palettes): void {
  try {
    localStorage.setItem(PALETTE_KEY, JSON.stringify(palettes));
  } catch {
    // Same as the theme above: it applies for this session regardless.
  }
}

/**
 * Which preset a ground is currently showing, if any.
 *
 * Derived by comparing the colours rather than remembered as a name,
 * because a remembered name goes stale the moment somebody nudges one
 * slot — and that nudge is the common case. An empty override map is the
 * stylesheet's own palette, which is the `colors: null` entry.
 */
export function activePreset(palettes: Palettes, on: Ground): Preset | null {
  const palette = palettes[on];
  const set = SLOTS.filter(({ slot }) => palette[slot]);
  for (const preset of PRESETS) {
    if (preset.ground !== on) continue;
    if (preset.colors === null) {
      if (set.length === 0) return preset;
      continue;
    }
    if (set.length !== SLOTS.length) continue;
    const colors = preset.colors;
    if (SLOTS.every(({ slot }) => palette[slot] === colors[slot])) return preset;
  }
  return null;
}
