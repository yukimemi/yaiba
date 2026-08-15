import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import {
  activePreset,
  ground,
  isHex,
  GROUNDS,
  PRESETS,
  SLOTS,
  type Ground,
  type Palettes,
  type Preset,
  type Slot,
  type SlotSpec,
  type Theme,
} from "../theme";

/**
 * The colours, and only the colours.
 *
 * Everything else this panel could plausibly hold — the theme, the
 * language, the view, the columns, the sort — already has a key and, for
 * the ones a mouse-only user would go looking for, a control in the bar.
 * That is the same rule the row menu is held to: a panel earns an entry
 * by being the only way to reach it. Colours were the one setting with no
 * route at all, so they are what this is.
 *
 * The keyboard bargain is the one every overlay here makes. `App` stands
 * its own handler down while this is up, which means the panel owes it a
 * way back: `esc`, a backdrop that closes on any outside press, and a
 * `Tab` that cannot escape the panel. RowMenu shipped without that last
 * one and could be tabbed onto `<body>`, where nothing was listening for
 * `esc` any more and the only way out was the mouse.
 *
 * There is no `onBlur` close, unlike RowMenu: that panel floats, and this
 * one covers the screen, so every press that lands outside it lands on
 * the backdrop. Adding one would be actively wrong here — the native
 * colour picker is a window of its own, so opening it blurs the swatch
 * and would close the panel underneath the dialog the user just asked
 * for.
 */

interface Props {
  theme: Theme;
  palettes: Palettes;
  /** Set one slot on the ground being shown, or clear it back. */
  onSet: (slot: Slot, hex: string | null) => void;
  onPreset: (preset: Preset) => void;
  /** Show the other ground — which means switching the theme to it. */
  onGround: (on: Ground) => void;
  onClose: () => void;
}

/**
 * The controls `Tab` walks, in DOM order.
 *
 * `:not(:disabled)` is load-bearing rather than tidy: the last row's `×`
 * is disabled whenever that colour is the stylesheet's own, which is the
 * usual case — and a disabled button cannot take focus, so a trap that
 * counted it would be watching for a boundary the caret can never reach
 * and `Tab` would walk straight out of the panel onto the HUD.
 */
const FOCUSABLE = "input:not(:disabled), button:not(:disabled)";

export function Settings({
  theme,
  palettes,
  onSet,
  onPreset,
  onGround,
  onClose,
}: Props) {
  const on = ground(theme);
  const panel = useRef<HTMLDivElement>(null);

  /**
   * What each slot is drawn in right now — an override where there is
   * one, the stylesheet's own value where there is not.
   *
   * Read off the element the overrides are written to rather than kept as
   * a table here, because a table would be a second copy of `:root` and
   * the copy is what goes stale. It can be read during the render because
   * `App` applies a palette in the same breath as it sets it, the way
   * `applyTheme` has always been called from inside `setTheme` — so by
   * the time this runs, the DOM already agrees with `palettes`.
   */
  const shown = useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const out = {} as Record<Slot, string>;
    for (const { slot } of SLOTS) {
      const raw = style.getPropertyValue(`--${slot}`).trim().toLowerCase();
      // `<input type="color">` takes `#rrggbb` and nothing else: given
      // `#fff` it silently shows black, which reads as the panel having
      // lost the colour rather than as a notation it declined.
      out[slot] = /^#[0-9a-f]{3}$/.test(raw)
        ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
        : raw;
    }
    return out;
  }, [palettes, theme]);

  const presets = PRESETS.filter((preset) => preset.ground === on);
  const active = activePreset(palettes, on);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || (e.ctrlKey && e.key === "[")) {
      onClose();
    } else if (e.key === "Tab") {
      const fields = [
        ...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
      ];
      if (!fields.length) return;
      const focused = document.activeElement;
      const first = fields[0];
      const last = fields[fields.length - 1];
      // Only the two ends are intercepted; in between, Tab is the
      // browser's own and moves as a Tab should.
      if (e.shiftKey && (focused === first || focused === panel.current)) {
        last.focus();
      } else if (!e.shiftKey && focused === last) {
        first.focus();
      } else {
        return;
      }
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="settings" onMouseDown={onClose}>
      <div
        className="settings__panel"
        ref={panel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("colours")}
      >
        <div className="settings__head">
          <span className="settings__sigil">{t("colours")}</span>
          {/* The tab switches the theme with it. Editing a ground you
              cannot see is not editing, and the alternative — a preview
              swatch per row while the screen stays in the other ground —
              is a second, smaller answer to the same question. */}
          <span className="settings__grounds">
            {GROUNDS.map((each) => (
              <button
                key={each}
                type="button"
                className={`settings__ground${each === on ? " is-on" : ""}`}
                onClick={() => onGround(each)}
              >
                {each === "neon" ? t("neon") : t("office")}
              </button>
            ))}
          </span>
        </div>

        <div className="settings__presets">
          <span className="settings__label">{t("preset")}</span>
          {presets.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className={`settings__preset${preset === active ? " is-on" : ""}`}
              onClick={() => onPreset(preset)}
            >
              {preset.name}
            </button>
          ))}
        </div>

        <ul className="settings__slots">
          {SLOTS.map((spec) => (
            <SlotRow
              key={spec.slot}
              spec={spec}
              value={shown[spec.slot]}
              overridden={Boolean(palettes[on][spec.slot])}
              onSet={onSet}
            />
          ))}
        </ul>

        <div className="settings__foot">
          {t(
            "a preset writes all twelve · × puts one back · esc close — the glow lives on gs, not here",
          )}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  spec: SlotSpec;
  value: string;
  overridden: boolean;
  onSet: (slot: Slot, hex: string | null) => void;
}

function SlotRow({ spec, value, overridden, onSet }: RowProps) {
  /**
   * What the text field is showing, which is not the same thing as the
   * colour: `#f0` on the way to `#f0a` is neither a colour nor a mistake,
   * and a field bound straight to the palette would fight the typing.
   */
  const [draft, setDraft] = useState(value);
  /**
   * The last colour this field committed, so it can tell its own echo from
   * somebody else's edit.
   */
  const mine = useRef<string | null>(null);

  /**
   * Follow the palette when it moves under us — a preset picked from the
   * row above has to land in all twelve fields, a `×` in this one, and the
   * swatch beside it moves this field as it is dragged — but never when
   * the new value is the one this field just wrote.
   *
   * That exception is the whole of it, and it was missing first. `#cc0` on
   * the way to `#cc0077` is a *valid* three-digit hex, so it commits and
   * comes straight back as the new `value`; written into the field the
   * caret is still in, what appears is `#cccc00077`. Guarding on focus
   * instead looks equivalent and is not: a `×` on this very row is an
   * outside change that arrives while the field still holds the caret, and
   * it would leave the row showing a colour the palette no longer has.
   */
  useEffect(() => {
    if (value === mine.current) return;
    setDraft(value);
  }, [value]);

  return (
    <li className="settings__slot">
      <input
        type="color"
        className="settings__swatch"
        aria-label={t(spec.label)}
        value={value}
        onChange={(e) => onSet(spec.slot, e.target.value)}
      />
      <input
        type="text"
        className="settings__hex"
        spellCheck={false}
        autoComplete="off"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (!isHex(e.target.value)) return;
          const next = e.target.value.trim().toLowerCase();
          mine.current = next;
          onSet(spec.slot, next);
        }}
        // Half-typed text that never became a colour is not a state to
        // leave on screen: the palette is what it was, and the field
        // should say so.
        onBlur={() => setDraft(value)}
      />
      <span className="settings__name">{t(spec.label)}</span>
      {/* Only where there is something to put back, so the column reads
          as "you have changed these" at a glance. */}
      <button
        type="button"
        className={`settings__clear${overridden ? "" : " is-off"}`}
        disabled={!overridden}
        title={t("back to the stylesheet's own")}
        onClick={() => onSet(spec.slot, null)}
      >
        ×
      </button>
    </li>
  );
}
