import { useEffect, useRef } from "react";

import { shortLabel, toISO, weekdayLabel } from "../dates";
import { t } from "../i18n";
import type { Lang } from "../lang";
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
  /** Open tasks whose computed finish is past their due date. */
  overdueCount: number;
  /**
   * Open tasks whose computed finish is already behind the reference
   * date — counted over leaves, since a summary carries `late` from its
   * children and counting both would report one overrun once per
   * ancestor standing over it.
   */
  lateCount: number;
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
  /**
   * The deepest level currently on screen, or null when nothing is
   * folded.
   *
   * Derived from what is drawn rather than from the depth `zm` / `zM`
   * were last asked for: those are the same number until a per-row `za`
   * opens one subtree, and then the remembered depth would be claiming a
   * view the list is no longer showing. A readout that lies is worse than
   * no readout.
   */
  foldLevel: number | null;
  focusTitle: string | null;
  theme: Theme;
  /** Flip between office mode and the neon HUD. */
  onToggleTheme: () => void;
  /** Flip between super mode and the neon HUD. */
  onToggleSuper: () => void;
  /** Which language the weekday beside the reference date is in. */
  lang: Lang;
  /** Flip the calendar between English and Japanese. */
  onToggleLang: () => void;
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
  overdueCount,
  lateCount,
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
  onToggleSuper,
  lang,
  onToggleLang,
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
      {/* The mode name stays English in either language, the way the
          keys do: `INSERT` is what every modal editor calls it, and a
          translated one would be a word you cannot look up. */}
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
            ? t("{n} projects open — switch, rename, forget (or :proj)", {
                n: projectCount,
              })
            : t("projects — new, rename, forget (or :proj)")
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
          title={t("a day earlier (:asof -1d)")}
        >
          ◀
        </button>
        <button
          type="button"
          className="hud__asof-date"
          onClick={onToggleAsof}
          title={
            isAsOf
              ? t(
                  "computed as of {d} — edits stay refused until you are back at now",
                  { d: reference },
                )
              : t(
                  "reference date — everything on screen is computed against it (:asof)",
                )
          }
        >
          {shortLabel(reference)}
          <span className="hud__asof-day">{weekdayLabel(reference, lang)}</span>
        </button>
        {/* Forward runs past today on purpose: `:asof +3d` always did,
            and "if nothing moves, how far behind is this by Friday" is
            a fair question. The one date that must send `null` instead
            is today itself — see `stepReference`. */}
        <button
          type="button"
          className="hud__asof-step"
          onClick={() => onStepAsof(1)}
          title={t("a day later (:asof +1d)")}
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
              {t("now")}
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
          {t("only")} <b>{focusTitle}</b>
        </span>
      )}
      {foldLevel !== null && (
        <span className="hud__stat">
          {t("level")} <b>{foldLevel}</b>
        </span>
      )}
      {filter && (
        <span className="hud__stat">
          {t("filter")} <b>{filter}</b> · {visibleCount}
        </span>
      )}
      <span className="hud__stat">
        {t("crit")} <b>{criticalCount}</b>
      </span>
      {/* Beside `crit` rather than inside the list, because the list is
          the one thing a fold can hide: at `zM` a plan is one row, and
          without a readout up here nothing on screen would say that
          something inside it overran weeks ago (#134). Shown only when
          non-zero, like `overdue` — a standing `late 0` is noise on a
          plan that is fine. */}
      {lateCount > 0 && (
        <span className="hud__stat hud__stat--overdue">
          {t("late")} <b>{lateCount}</b>
        </span>
      )}
      {overdueCount > 0 && (
        <span className="hud__stat hud__stat--overdue">
          {t("overdue")} <b>{overdueCount}</b>
        </span>
      )}
      <span className="hud__stat">
        {t("ends")} <b>{projectEnd}</b>
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
          theme === "light"
            ? t("neon mode (gt)")
            : t("office mode — light, no glow (gt)")
        }
      >
        {theme === "light"
          ? t("◑ office")
          : theme === "super"
            ? t("◈ super")
            : t("◐ neon")}
      </button>
      {/* Its own button rather than a third stop on the one beside it:
          office mode is a setting somebody needs in a hurry, in a
          meeting, and a cycle would make them pass through the loudest
          screen this app can draw to reach the quietest. `is-on` is what
          lights it, so the switch reads as a switch. */}
      <button
        type="button"
        className={`hud__super${theme === "super" ? " is-on" : ""}`}
        onClick={onToggleSuper}
        title={
          theme === "super"
            ? t("back to neon mode (gs)")
            : t("super mode — every effect at maximum (gs)")
        }
      >
        {theme === "super" ? t("◈ SUPER") : t("◇ super")}
      </button>
      {/* Beside the theme for the same reason: it is a setting about
          what the screen says, and the only sign it exists is here. */}
      <button
        type="button"
        className="hud__lang"
        onClick={onToggleLang}
        // Written in the language it switches *to*, not the one you are
        // in: the person who needs this button is the one who cannot
        // read the language currently on screen.
        title={lang === "en" ? "日本語で表示 (:lang ja)" : "in English (:lang en)"}
      >
        {lang === "en" ? "en" : "ja"}
      </button>
      <span
        className="hud__peers"
        data-live={peerCount > 0}
        title={
          syncOn
            ? t(
                "node {id} · :ticket to share, :join <ticket> to open theirs beside yours",
                { id: nodeId },
              )
            : t("started with --no-sync")
        }
      >
        {!syncOn
          ? t("◌ local")
          : peerCount === 0
            ? t("◉ solo")
            : peerCount === 1
              ? t("◉ 1 peer")
              : t("◉ {n} peers", { n: peerCount })}
      </span>
    </header>
  );
}
