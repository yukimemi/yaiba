import { useEffect, useRef } from "react";

import { shortLabel, toISO, weekdayLabel } from "../dates";
import type { Mode } from "../mode";
import type { Theme } from "../theme";
import type { Task } from "../types";

/**
 * Jumps the picker offers a mouse.
 *
 * Whole weeks rather than "-1m" / "-3m": the step is applied in days,
 * and a button labelled by a month that moves 30 of them would be off
 * by a day or three depending on where you started.
 */
const ASOF_STEPS: [string, number][] = [
  ["-1w", -7],
  ["-2w", -14],
  ["-4w", -28],
];

interface Props {
  mode: Mode;
  tasks: Task[];
  visibleCount: number;
  criticalCount: number;
  nodeId: string;
  filter: string;
  projectEnd: string;
  peerCount: number;
  syncOn: boolean;
  /**
   * The date the whole view is computed against — always shown, because
   * every bar, percentage and overdue flag on screen is relative to it.
   */
  reference: string;
  /** True when `reference` is a chosen date rather than now. */
  isAsOf: boolean;
  /** The picker is open; its state lives in App so keys route correctly. */
  asofOpen: boolean;
  onToggleAsof: () => void;
  onCloseAsof: () => void;
  /** Walk the reference date by whole days. */
  onStepAsof: (days: number) => void;
  /** Jump straight to a date, or back to now with null. */
  onSetAsof: (date: string | null) => void;
  /** Null when every level is shown. */
  foldLevel: number | null;
  focusTitle: string | null;
  theme: Theme;
  /** Flip between the neon HUD and office mode. */
  onToggleTheme: () => void;
  /** The project on screen, and the way in for a mouse. */
  project: string;
  projectCount: number;
  onOpenProjects: () => void;
}

const METER_CELLS = 10;

/** Top bar: what mode you're in, and how the project is actually doing. */
export function Hud({
  mode,
  tasks,
  visibleCount,
  criticalCount,
  nodeId,
  filter,
  projectEnd,
  peerCount,
  syncOn,
  reference,
  isAsOf,
  asofOpen,
  onToggleAsof,
  onCloseAsof,
  onStepAsof,
  onSetAsof,
  foldLevel,
  focusTitle,
  theme,
  onToggleTheme,
  project,
  projectCount,
  onOpenProjects,
}: Props) {
  const done = tasks.filter((t) => t.status === "done").length;
  const filled = tasks.length
    ? Math.round((done / tasks.length) * METER_CELLS)
    : 0;

  // Read once per render rather than per handler, so the ceiling the
  // date field advertises and the one the change handler enforces are
  // the same day even at a midnight rollover.
  const liveToday = toISO(new Date());

  // Click-away close. The popover sits in the HUD rather than over the
  // whole screen, so there is no backdrop to catch the click for it.
  const asofRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!asofOpen) return;
    const away = (e: MouseEvent) => {
      if (!asofRef.current?.contains(e.target as Node)) onCloseAsof();
    };
    // `mousedown`, not `click`: the row underneath sets the cursor on
    // mousedown too, and a `click` listener would fire second — closing
    // the popover only after the click had already moved the cursor.
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [asofOpen, onCloseAsof]);

  return (
    <header className="hud">
      <span className="hud__mark">
        YAIBA<span className="hud__kanji">刃</span>
      </span>
      <span className="hud__mode" data-mode={mode}>
        {mode.toUpperCase()}
      </span>

      {/* The only pointer-driven way into the palette. The keyboard has
          `:proj`; without this a mouse has no route to projects at all. */}
      <button
        type="button"
        className="hud__project"
        onClick={onOpenProjects}
        title={
          projectCount > 1
            ? `${projectCount} projects open — switch, rename, forget (or :proj)`
            : "projects — new, rename, forget (or :proj)"
        }
      >
        {project || "—"}
        {projectCount > 1 && (
          <span className="hud__project-count">{projectCount}</span>
        )}
      </button>

      <span className="hud__spacer" />

      {/* The reference date, always on screen. Every bar, percentage and
          overdue flag is computed against it, and until now it only
          appeared once it was *wrong* — which meant the number the whole
          view hangs on was the one thing the view never stated. Quiet at
          now, lit when you are reading the past. */}
      <div
        className={`hud__asof${isAsOf ? " hud__asof--off-now" : ""}`}
        ref={asofRef}
      >
        <button
          type="button"
          className="hud__asof-step"
          onClick={() => onStepAsof(-1)}
          title="a day earlier (:asof -1d)"
        >
          ◀
        </button>
        <button
          type="button"
          className="hud__asof-date"
          onClick={onToggleAsof}
          title={
            isAsOf
              ? `computed as of ${reference} — edits stay refused until you are back at now`
              : "reference date — everything on screen is computed against it (:asof)"
          }
        >
          {shortLabel(reference)}
          <span className="hud__asof-day">{weekdayLabel(reference)}</span>
        </button>
        {/* Forward runs past today on purpose: `:asof +3d` always did,
            and "if nothing moves, how far behind is this by Friday" is
            a fair question. The one date that must send `null` instead
            is today itself — see `stepReference`. */}
        <button
          type="button"
          className="hud__asof-step"
          onClick={() => onStepAsof(1)}
          title="a day later (:asof +1d)"
        >
          ▶
        </button>

        {asofOpen && (
          <div className="hud__asof-menu">
            <button
              type="button"
              className="hud__asof-item"
              onClick={() => {
                onSetAsof(null);
                onCloseAsof();
              }}
              disabled={!isAsOf}
            >
              now
            </button>
            {ASOF_STEPS.map(([label, days]) => (
              <button
                key={label}
                type="button"
                className="hud__asof-item"
                onClick={() => {
                  onStepAsof(days);
                  onCloseAsof();
                }}
              >
                {label}
              </button>
            ))}
            {/* The only thing here a mouse cannot otherwise reach: an
                arbitrary date. A keyboard already has `:asof 2026-07-20`. */}
            <input
              type="date"
              className="hud__asof-input"
              value={reference}
              onChange={(e) => {
                const picked = e.target.value;
                if (!picked) return;
                onSetAsof(picked === liveToday ? null : picked);
                onCloseAsof();
              }}
            />
          </div>
        )}
      </div>
      {focusTitle && (
        <span className="hud__stat">
          only <b>{focusTitle}</b>
        </span>
      )}
      {foldLevel !== null && (
        <span className="hud__stat">
          level <b>{foldLevel}</b>
        </span>
      )}
      {filter && (
        <span className="hud__stat">
          filter <b>{filter}</b> · {visibleCount}
        </span>
      )}
      <span className="hud__stat">
        crit <b>{criticalCount}</b>
      </span>
      <span className="hud__stat">
        ends <b>{projectEnd}</b>
      </span>
      <span className="hud__meter">
        <span className="hud__bar">
          {"▓".repeat(filled)}
          <span>{"░".repeat(METER_CELLS - filled)}</span>
        </span>
        {done}/{tasks.length}
      </span>
      {/* `gt` toggles the theme, but office mode is the one setting a
          mouse-only user is most likely to want and least likely to
          find in `?`. */}
      <button
        type="button"
        className="hud__theme"
        onClick={onToggleTheme}
        title={
          theme === "dark"
            ? "office mode — light, no glow (gt)"
            : "neon mode (gt)"
        }
      >
        {theme === "dark" ? "◐ neon" : "◑ office"}
      </button>
      <span
        className="hud__peers"
        data-live={peerCount > 0}
        title={
          syncOn
            ? `node ${nodeId} · :ticket to share, :join <ticket> to connect`
            : "started with --no-sync"
        }
      >
        {!syncOn
          ? "◌ local"
          : peerCount === 0
            ? "◉ solo"
            : `◉ ${peerCount} peer${peerCount === 1 ? "" : "s"}`}
      </span>
    </header>
  );
}
