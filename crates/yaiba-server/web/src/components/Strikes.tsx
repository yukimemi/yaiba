import { useEffect, useRef } from "react";

import {
  COMBO_CAP,
  COMBO_FLOOR,
  COMBO_MS,
  JOLT_CLASSES,
  JOLT_MAX_PX,
  STRIKE_LIMIT,
  STRIKES_MAX,
  STRIKES_MIN,
} from "../strike";

interface Props {
  /** Super mode is the only place this draws — see `strike.ts`. */
  enabled: boolean;
  /** The shell that takes the recoil: `App`'s own `.app` element. */
  shell: React.RefObject<HTMLDivElement | null>;
}

/**
 * A canvas 2D context, kept for measuring text and nothing else.
 *
 * Lazily made and never attached to the document. `measureText` is the
 * only honest way to ask where the caret is inside an `<input>`: the app
 * is monospace, so `column × width` looks like it would do, and it is
 * wrong the moment a title is in Japanese — those glyphs are full-width
 * in every one of the fonts `--mono` names, and this is a UI that ships
 * with a Japanese half. Measuring the actual prefix costs one call and
 * is right in both scripts.
 */
let measurer: CanvasRenderingContext2D | null = null;

function caretPoint(el: HTMLInputElement | HTMLTextAreaElement) {
  const rect = el.getBoundingClientRect();
  if (!rect.width) return null;
  measurer ??= document.createElement("canvas").getContext("2d");
  const at = el.selectionStart ?? el.value.length;
  let x = rect.left;
  const style = getComputedStyle(el);
  if (measurer) {
    // Composed by hand rather than read from `style.font`, which some
    // engines return empty when the shorthand was never written.
    measurer.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    x += (parseFloat(style.paddingLeft) || 0);
    x += measurer.measureText(el.value.slice(0, at)).width - el.scrollLeft;
  }
  return {
    // A caret scrolled out of a narrow input would otherwise throw
    // strikes off the side of the field it is in.
    x: Math.min(Math.max(x, rect.left), rect.right),
    y: rect.top + rect.height / 2,
  };
}

/**
 * Strikes off the caret, and the shell's recoil behind them.
 *
 * Deliberately imperative. Every keystroke would otherwise be a state
 * update on `App` — the component that owns the task list, the schedule
 * and the gantt — to add three elements that describe nothing and are
 * gone in 400ms. Nothing here is state: the nodes take themselves out on
 * `animationend`, and unmounting the layer takes any survivor with it.
 *
 * That is also why the whole thing hangs off one `window` listener
 * rather than the inputs' own handlers: typing happens in a row title,
 * the `:` line, the search line, the project palette and the owner
 * panel, and a decoration is not a reason for five components to learn
 * about each other.
 */
export function Strikes({ enabled, shell }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const combo = useRef(0);
  const idle = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const el = layer.current;
    if (!el) return;

    // Read per keystroke rather than at mount, so a preference changed
    // mid-session is honoured without a listener of its own. The check
    // is here as well as in the stylesheet because a node whose
    // animation never runs never fires `animationend` — with the CSS
    // silenced, spawning would be a leak rather than an effect.
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");

    const combos = () => Math.min(combo.current, COMBO_CAP) / COMBO_CAP;

    const draw = (x: number, y: number, weight: number) => {
      const count = Math.min(
        STRIKES_MAX,
        STRIKES_MIN + Math.round(combos() * (STRIKES_MAX - STRIKES_MIN)) + weight,
      );
      for (let i = 0; i < count; i += 1) {
        if (el.childElementCount >= STRIKE_LIMIT) return;
        const strike = document.createElement("i");
        strike.className = "strike";
        // Fanned upward, because that is where a blade leaves and
        // because the row below the caret is the next thing you are
        // going to read.
        const angle = -20 - Math.random() * 140;
        const reach = 26 + Math.random() * 46;
        const radians = (angle * Math.PI) / 180;
        strike.style.setProperty("--x", `${x}px`);
        strike.style.setProperty("--y", `${y}px`);
        strike.style.setProperty("--dx", `${Math.cos(radians) * reach}px`);
        strike.style.setProperty("--dy", `${Math.sin(radians) * reach}px`);
        strike.style.setProperty("--rot", `${angle + 90 + (Math.random() * 30 - 15)}deg`);
        strike.style.setProperty("--len", `${10 + Math.random() * 16}px`);
        strike.addEventListener("animationend", () => strike.remove(), {
          once: true,
        });
        el.appendChild(strike);
      }
    };

    /** The counter, as a node rather than as state — see the note above. */
    const say = (x: number, y: number) => {
      let tag = el.querySelector<HTMLSpanElement>(".combo");
      if (combo.current < COMBO_FLOOR) {
        tag?.remove();
        return;
      }
      if (!tag) {
        tag = document.createElement("span");
        tag.className = "combo";
        el.appendChild(tag);
      }
      tag.textContent = `×${combo.current}`;
      tag.style.setProperty("--x", `${x}px`);
      tag.style.setProperty("--y", `${y}px`);
      // Re-tiering on every keystroke is what makes it climb; the
      // stylesheet reads it to decide how hot the number burns.
      tag.dataset.tier = String(Math.min(3, Math.floor(combo.current / 10)));
    };

    const recoil = () => {
      const host = shell.current;
      if (!host) return;
      host.style.setProperty(
        "--jolt",
        `${(0.6 + combos() * (JOLT_MAX_PX - 0.6)).toFixed(2)}px`,
      );
      const [a, b] = JOLT_CLASSES;
      const next = host.classList.contains(a) ? b : a;
      host.classList.remove(a, b);
      host.classList.add(next);
    };

    const hit = (
      target: HTMLInputElement | HTMLTextAreaElement,
      weight: number,
    ) => {
      if (still.matches) return;
      const point = caretPoint(target);
      if (!point) return;
      combo.current += 1;
      window.clearTimeout(idle.current);
      idle.current = window.setTimeout(() => {
        combo.current = 0;
        el.querySelector(".combo")?.remove();
      }, COMBO_MS);
      draw(point.x, point.y, weight);
      say(point.x, point.y);
      recoil();
    };

    const typing = (e: KeyboardEvent) => {
      const target = e.target;
      if (
        !(target instanceof HTMLInputElement) &&
        !(target instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      // A shortcut is not a keystroke. A composition is one, but not
      // through here: Chrome reports `key: "Process"` while an IME is
      // composing, so these keydowns fall out at the printable test
      // below whether or not `isComposing` was set on them. Japanese
      // arrives at the composition listener instead — without that half
      // the mode is silent for exactly the users the `ja` UI is for.
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (e.key.length !== 1 && e.key !== "Backspace") return;
      hit(target, 0);
    };

    /**
     * The composing half, which is most of Japanese.
     *
     * `compositionupdate` is the keystroke: one per kana as the reading
     * is typed, and again when 変換 changes the candidate. It is what
     * makes typing Japanese feel like typing at all, and leaving it out
     * is what made the first version read as "Japanese isn't supported"
     * — during composition Chrome reports `key: "Process"` on every
     * keydown, so the printable-character test above lets the whole word
     * through untouched, and the only thing that ever drew was the
     * commit at the end.
     *
     * `compositionend` still lands on top of it, heavier: the commit is
     * the moment the word is actually cut, and a conversion committing
     * several characters at once has done more than one keystroke's
     * worth. Capped, because a long conversion is still one gesture.
     */
    const composing = (e: Event) => {
      const target = e.target;
      if (
        !(target instanceof HTMLInputElement) &&
        !(target instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      const data = (e as CompositionEvent).data ?? "";
      hit(target, e.type === "compositionend" ? Math.min(3, data.length) : 0);
    };

    window.addEventListener("keydown", typing, true);
    window.addEventListener("compositionupdate", composing, true);
    window.addEventListener("compositionend", composing, true);
    return () => {
      window.removeEventListener("keydown", typing, true);
      window.removeEventListener("compositionupdate", composing, true);
      window.removeEventListener("compositionend", composing, true);
      window.clearTimeout(idle.current);
      combo.current = 0;
      // Leaving super mode mid-flight: the rules that animate these stop
      // matching, so `animationend` never comes for whatever is in the
      // air. Nothing else takes them out.
      el.replaceChildren();
      shell.current?.classList.remove(...JOLT_CLASSES);
    };
  }, [enabled, shell]);

  if (!enabled) return null;
  return <div className="strikes" ref={layer} aria-hidden="true" />;
}
