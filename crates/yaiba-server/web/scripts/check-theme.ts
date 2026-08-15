/**
 * The palette is a contract between `theme.ts` and `styles.css`, and
 * nothing in either language can see the other half of it.
 *
 * A user can now replace the value of every colour slot (`gc`), which
 * turns two things that used to be harmless into bugs the default theme
 * can never show:
 *
 *  1. **A palette colour written as a literal.** `rgba(34, 211, 238, 0.1)`
 *     and `rgb(from var(--edge) r g b / 0.1)` are the same pixels until
 *     somebody makes the blade green — and then the glow stays cyan while
 *     the thing glowing changes, in one rule out of a hundred. Every
 *     numeric `rgb()` in the stylesheet therefore has to be white or
 *     black, the two colours that are deliberately not slots.
 *  2. **A slot with nothing behind it.** The panel builds its rows from
 *     `SLOTS`, so a slot whose custom property no block declares renders
 *     as a control that changes nothing, and a declaration no slot names
 *     is a colour the panel cannot reach.
 *
 * Run by `web-build`, like the other checks here: `tsc` sees none of it,
 * and neither does anything short of opening the panel and looking.
 */

import { readFileSync } from "node:fs";

import {
  activePreset,
  ground,
  isHex,
  themeFor,
  GROUNDS,
  NO_PALETTES,
  PRESETS,
  SLOTS,
  THEMES,
  type Ground,
  type Palettes,
  type Slot,
} from "../src/theme.ts";

/** The stylesheet, with its comments taken out — see `check-flash.ts`. */
const css = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

let ran = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  ran += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

/** The body of the block `header` opens, by brace depth. */
function block(header: string): string {
  const at = css.indexOf(header);
  if (at === -1) return "";
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

/** `--slot: value` pairs declared in one block. */
function declared(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

// ---- the two grounds ------------------------------------------------

const BLOCKS: Record<Ground, string> = {
  neon: ":root {",
  office: ':root[data-theme="light"] {',
};

const palette: Record<Ground, Map<string, string>> = {
  neon: declared(block(BLOCKS.neon)),
  office: declared(block(BLOCKS.office)),
};

for (const on of GROUNDS) {
  check(
    `the ${on} ground has a block in styles.css`,
    palette[on].size > 0,
    `nothing in styles.css opens \`${BLOCKS[on]}\`, so ${on} has no colours ` +
      `to override and the panel's ${on} tab edits a ground that is not there.`,
  );
}

// Every slot the panel offers is declared on both grounds. Not just the
// neon one: office mode's colours are a *rule*, and the overrides are
// inline properties that outrank it, so a slot missing from the office
// block would be edited on the office tab and then inherit the neon value
// the moment the override came off.
for (const { slot } of SLOTS) {
  for (const on of GROUNDS) {
    const value = palette[on].get(`--${slot}`);
    check(
      `${on} declares --${slot}`,
      value !== undefined,
      `SLOTS names \`${slot}\` and \`${BLOCKS[on]}\` never declares ` +
        `--${slot}, so the panel would show a control that changes nothing.`,
    );
    if (value !== undefined) {
      check(
        `${on}'s --${slot} is a hex colour`,
        isHex(value),
        `--${slot} is \`${value}\`. The panel seeds \`<input type="color">\` ` +
          `from the computed value, which takes \`#rrggbb\` and shows black ` +
          `for anything else.`,
      );
    }
  }
}

/**
 * Declarations in the palette blocks that are deliberately not slots.
 *
 * `--glow` is the one worth stating: every shadow in the app is
 * `calc(Npx * var(--glow))`, so a palette able to set it could light the
 * neon back up in the one mode whose whole job is surviving a shared
 * screen. Loudness lives on `gs`. The rest are metrics and a font stack.
 */
const NOT_COLOURS: Record<string, true> = {
  "--row-h": true,
  "--gutter": true,
  "--pane-tail": true,
  "--pane-head": true,
  "--mono": true,
  "--glow": true,
};

const named = new Set(SLOTS.map(({ slot }) => `--${slot}`));

// Nothing declared is left unreachable. A thirteenth colour in the block
// with no slot naming it is a colour the panel cannot edit, which is how a
// "customisable palette" ends up with one rule nobody can move.
for (const on of GROUNDS) {
  for (const [property] of palette[on]) {
    if (NOT_COLOURS[property] || named.has(property)) continue;
    check(
      `${on}'s ${property} is reachable from the panel`,
      false,
      `${BLOCKS[on]} declares ${property} and nothing in SLOTS names it. ` +
        `Add it to SLOTS with a label, or to NOT_COLOURS here if it is not ` +
        `a colour.`,
    );
  }
}

check(
  "the glow is not a slot",
  !named.has("--glow"),
  `--glow is in SLOTS. It is the whole of office mode — a palette that ` +
    `could set it would be able to light the effects over a white ` +
    `background, which is the combination the single \`data-theme\` ` +
    `attribute exists to make unsayable.`,
);

check(
  "office mode still switches the glow off",
  /--glow:\s*0\s*;/.test(block(BLOCKS.office)),
  `\`${BLOCKS.office}\` no longer sets --glow: 0, so every shadow, sweep ` +
    `and scanline is lit on the shared screen.`,
);

// The catalogue says "all twelve" in both languages, and a preset really
// does write all of them.
check(
  "there are twelve slots",
  SLOTS.length === 12,
  `SLOTS has ${SLOTS.length} entries, and the panel's footer says twelve — ` +
    `in English and in Japanese. Reword both, or keep the count.`,
);

check(
  "every slot has a label, and no two share one",
  new Set(SLOTS.map(({ label }) => label)).size === SLOTS.length &&
    SLOTS.every(({ label }) => label.length > 0),
  `two slots carry the same label, or one carries none. The label is the ` +
    `only thing on the row that says which colour it is.`,
);

// ---- no colour may bypass the palette -------------------------------

/**
 * White and black are not slots: white is super mode's blown highlight
 * and the flash along a severed edge, black is a shadow, and a mask needs
 * both as ink. Everything else in the app is a slot at some alpha.
 */
const INK: Record<string, true> = { "255,255,255": true, "0,0,0": true };

const literals = [
  ...css.matchAll(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(?:calc\((?:[^()]|\([^()]*\))*\)|[\d.]+)\s*)?\)/g,
  ),
].filter((m) => !INK[`${m[1]},${m[2]},${m[3]}`]);

check(
  "no rule writes a colour as an rgb() literal",
  literals.length === 0,
  literals
    .map((m) => `${m[0]} — write it as rgb(from var(--slot) r g b / a)`)
    .join("\n       "),
);

// The same rule for hex, which is how the two blends in the file were
// written before they became `color-mix`. Only the palette blocks may name
// a colour outright.
const outside = css
  .replace(block(BLOCKS.neon), "")
  .replace(block(BLOCKS.office), "");
const strayHex = [...outside.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].filter(
  (m) => !/^#(?:fff|000|ffffff|000000)$/i.test(m[0]),
);
check(
  "no rule writes a colour as a hex literal",
  strayHex.length === 0,
  strayHex
    .map(
      (m) =>
        `${m[0]} — name a slot, or color-mix(in srgb, var(--a) N%, var(--b)) ` +
        `if it is one lifted into another`,
    )
    .join("\n       "),
);

/**
 * Variables the stylesheet reads and JavaScript writes, each with what
 * sets it.
 *
 * An undeclared `var()` is not a no-op: it is invalid at computed-value
 * time, which makes `color` inherit and `background` fall away to
 * transparent. Both draw *something* plausible, which is how three of them
 * survived in the row menu until this check went in.
 */
const FROM_JS: Record<string, string> = {
  "--list-w": "split.ts, applySplit",
  "--x": "Strikes.tsx",
  "--y": "Strikes.tsx",
  "--dx": "Strikes.tsx",
  "--dy": "Strikes.tsx",
  "--rot": "Strikes.tsx",
  "--len": "Strikes.tsx",
  "--jolt": "Strikes.tsx",
};

const everyDeclared = new Set(
  [...css.matchAll(/^\s+(--[a-z-]+):/gm)].map((m) => m[1]),
);
for (const m of css.matchAll(/var\((--[a-z-]+)/g)) {
  if (everyDeclared.has(m[1]) || FROM_JS[m[1]]) continue;
  check(
    `var(${m[1]}) is declared somewhere`,
    false,
    `nothing declares ${m[1]}, and an invalid var() draws something ` +
      `plausible and wrong rather than nothing: \`color\` inherits, ` +
      `\`background\` falls back to transparent.`,
  );
}

// ---- the presets ----------------------------------------------------

for (const on of GROUNDS) {
  const mine = PRESETS.filter((preset) => preset.ground === on);
  check(
    `the ${on} ground has presets`,
    mine.length > 1,
    `${on} has ${mine.length} preset(s). The panel's preset row would be ` +
      `the built-in alone, which is a row that does nothing.`,
  );
  check(
    `${on} has exactly one built-in`,
    mine.filter((preset) => preset.colors === null).length === 1,
    `\`colors: null\` is the stylesheet's own palette — the entry that ` +
      `clears the overrides. Two of them are two names for one thing; none ` +
      `means there is no way back from a preset.`,
  );
  check(
    `${on}'s preset names are unique`,
    new Set(mine.map((preset) => preset.name)).size === mine.length,
    `two presets on the ${on} tab share a name, so one of them is a button ` +
      `that looks like the other.`,
  );
}

for (const preset of PRESETS) {
  const { name, colors } = preset;
  if (colors === null) continue;

  const missing = SLOTS.filter(({ slot }) => !colors[slot]).map((s) => s.slot);
  check(
    `${name} covers every slot`,
    missing.length === 0,
    `${name} leaves ${missing.join(", ")} unset. A preset is all twelve at ` +
      `once — a partial one mixes its own colours with whatever was there.`,
  );

  const bad = Object.entries(colors).filter(([, hex]) => !isHex(hex));
  check(
    `${name} is written in hex`,
    bad.length === 0,
    bad.map(([slot, hex]) => `${slot}: ${hex}`).join(", "),
  );

  // The four signals are the palette's whole point: cyan is structure,
  // magenta the critical path, amber overdue, green done. Two of them
  // sharing a value is a scheme that has quietly lost one meaning, which
  // is exactly what an all-green terminal palette would do.
  const signals: Slot[] = ["edge", "blood", "rust", "jade"];
  check(
    `${name} keeps the four signals apart`,
    new Set(signals.map((slot) => colors[slot])).size === signals.length,
    `${signals.map((s) => `${s}: ${colors[s]}`).join(", ")} — two of these ` +
      `are the same colour, so a row cannot say which of the two things it ` +
      `means.`,
  );

  // A preset equal to the stylesheet's own palette is the built-in wearing
  // a second name, and it would be the copy of `:root` that goes stale.
  const same = SLOTS.every(
    ({ slot }) => palette[preset.ground].get(`--${slot}`) === colors[slot],
  );
  check(
    `${name} is not a copy of the stylesheet`,
    !same,
    `${name} lists exactly what \`${BLOCKS[preset.ground]}\` already ` +
      `declares. That is what the \`colors: null\` entry is for.`,
  );
}

// ---- the pure rules the panel leans on ------------------------------

check(
  "every theme belongs to a ground",
  THEMES.every((theme) => GROUNDS.includes(ground(theme))),
  `\`ground()\` returned something that is not a ground.`,
);

// Super is not a third ground — it shares the neon block, which is what
// makes `gs` a question about loudness rather than about hues.
check(
  "dark and super read the same ground",
  ground("dark") === ground("super") && ground("light") === "office",
  `super has become a ground of its own, which means a second copy of the ` +
    `twelve colours and a palette the panel cannot reach from either tab.`,
);

// The tab switches the theme, and coming back from office must not drop
// somebody out of super — the tab is about hues, `gs` is about loudness.
check(
  "the neon tab keeps super",
  themeFor("neon", "super") === "super" &&
    themeFor("neon", "light") === "dark" &&
    themeFor("office", "super") === "light",
  `themeFor sends the neon tab to ${themeFor("neon", "super")} from super.`,
);

check(
  "an untouched ground shows the built-in",
  activePreset(NO_PALETTES, "neon")?.colors === null &&
    activePreset(NO_PALETTES, "office")?.colors === null,
  `with no overrides, the panel highlights no preset — so the way back to ` +
    `the default reads as one more scheme rather than as where you are.`,
);

for (const preset of PRESETS) {
  if (preset.colors === null) continue;
  const palettes: Palettes = {
    ...NO_PALETTES,
    [preset.ground]: { ...preset.colors },
  };
  check(
    `${preset.name} is recognised once applied`,
    activePreset(palettes, preset.ground)?.name === preset.name,
    `applying ${preset.name} leaves the panel highlighting ` +
      `${activePreset(palettes, preset.ground)?.name ?? "nothing"}. The ` +
      `active preset is derived by comparing colours, so this is either a ` +
      `duplicate scheme or a slot missing from one of them.`,
  );
}

console.log(`\ntheme: ${ran} checks, ${failures} failed`);
if (failures) process.exit(1);
