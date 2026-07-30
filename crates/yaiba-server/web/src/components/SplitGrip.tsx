import { useEffect, useRef, useState } from "react";

import { t } from "../i18n";
import {
  DEFAULT_SPLIT,
  MAX_SPLIT,
  MIN_SPLIT,
  applySplit,
  clampSplit,
  previewSplit,
} from "../split";

interface Props {
  /** The list's current share, so the arrows have somewhere to step from. */
  percent: number;
  /** Called once per gesture, with the width to remember. */
  onCommit: (percent: number) => void;
}

/** How far one arrow press moves the divider. */
const STEP = 2;

/**
 * The divider between the list and the timeline, draggable.
 *
 * It *is* the border — `.pane--list` gives up its `border-right` to this
 * — so what you grab is the line you see. The hit area is wider than the
 * line, for the same reason the dependency arrows opt back into
 * `pointer-events` over an 11px stroke: a 1px target is not something a
 * user can be asked to hit.
 *
 * The drag writes the CSS variable directly and only tells React on
 * release. Re-rendering the gantt on every pointer move is the difference
 * between a divider that follows the mouse and one that lags behind it,
 * and there is nothing to persist mid-gesture anyway.
 *
 * Keyboard-reachable, because nothing here should be mouse-only: it takes
 * focus, and the arrows step it. `:split ⟨percent⟩` sets it outright, and
 * `Home` — like a double-click — puts it back.
 */
export function SplitGrip({ percent, onCommit }: Props) {
  const grip = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * The live value during a drag.
   *
   * A ref rather than state for the reason the whole component avoids
   * state mid-gesture, and read by the `pointerup` handler below — which
   * is installed once per drag and would otherwise close over the value
   * as it was when the drag started.
   */
  const live = useRef(percent);

  // Kept in step with the prop whenever the width changes from outside —
  // which `:split 70` does, through `App`. Without this the arrows step
  // from whatever the last *gesture* left behind: focus the grip, run
  // `:split 70`, press `→`, and the divider jumps back near the old width
  // instead of nudging from 70. Skipped mid-drag, where the ref is ahead
  // of the prop on purpose and the prop has not caught up yet.
  useEffect(() => {
    if (!dragging) live.current = percent;
  }, [percent, dragging]);

  // Listeners on `window`, installed per-drag: the pointer leaves the
  // 7px grip on the first move of any real gesture, so a handler bound to
  // the element itself would stop hearing about it immediately.
  useEffect(() => {
    if (!dragging) return;
    const panes = grip.current?.closest(".panes");
    if (!panes) return;

    const onMove = (e: PointerEvent) => {
      const box = panes.getBoundingClientRect();
      if (box.width <= 0) return;
      const next = ((e.clientX - box.left) / box.width) * 100;
      live.current = clampSplit(next);
      previewSplit(live.current);
    };
    const onUp = () => {
      setDragging(false);
      // `applySplit`, not just `onCommit`: the moves above went through
      // `previewSplit`, which deliberately does not write to storage — so
      // without this the divider looked moved and went back to where it
      // was on the next reload. Every path that ends a gesture calls this,
      // and they should stay identical.
      applySplit(live.current);
      onCommit(live.current);
    };
    // Dragging across two panes of text otherwise selects all of it, and
    // the selection stays behind after the release. Restored on cleanup so
    // a cancelled gesture cannot leave the app unselectable.
    const selectable = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // A cancelled pointer — the OS taking over, a window switch — is a
    // release as far as the divider is concerned. Left out, the drag
    // would still be following the mouse after the gesture was over.
    window.addEventListener("pointercancel", onUp);
    return () => {
      document.body.style.userSelect = selectable;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, onCommit]);

  const step = (delta: number) => {
    const next = clampSplit(live.current + delta);
    live.current = next;
    applySplit(next);
    onCommit(next);
  };

  return (
    <div
      ref={grip}
      className={`panes__grip${dragging ? " panes__grip--dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={percent}
      aria-valuemin={MIN_SPLIT}
      aria-valuemax={MAX_SPLIT}
      tabIndex={0}
      title={t("drag to resize · double-click to reset")}
      onPointerDown={(e) => {
        // Left button only: a right-click here belongs to the browser's
        // own menu, and a middle-click paste is not a drag.
        if (e.button !== 0) return;
        // Stops the browser starting a text selection across both panes.
        e.preventDefault();
        // And then puts back the one default we wanted: focus. This is
        // the *only* way the grip is reachable — `tab` never gets here,
        // because the app's own handler normalises it to `<tab>` and
        // preventDefaults it to cycle the layout. So without this line
        // "drag it, then nudge with the arrows" is not merely awkward,
        // it is impossible, and the arrows are dead code.
        e.currentTarget.focus();
        live.current = percent;
        setDragging(true);
      }}
      onDoubleClick={() => {
        live.current = DEFAULT_SPLIT;
        applySplit(DEFAULT_SPLIT);
        onCommit(DEFAULT_SPLIT);
      }}
      onKeyDown={(e) => {
        // The app's own handler lives on `window`; stopping the event here
        // is what keeps `h` from folding a row behind the divider.
        if (e.key === "ArrowLeft" || e.key === "h") {
          e.preventDefault();
          e.stopPropagation();
          step(-STEP);
        } else if (e.key === "ArrowRight" || e.key === "l") {
          e.preventDefault();
          e.stopPropagation();
          step(STEP);
        } else if (e.key === "Home") {
          e.preventDefault();
          e.stopPropagation();
          live.current = DEFAULT_SPLIT;
          applySplit(DEFAULT_SPLIT);
          onCommit(DEFAULT_SPLIT);
        }
      }}
    />
  );
}
