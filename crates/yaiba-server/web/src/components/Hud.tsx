import type { Mode } from "../mode";
import type { Theme } from "../theme";
import type { Task } from "../types";

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
  /** Set when viewing a past date rather than now. */
  asof: string | null;
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
  asof,
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

      {asof && (
        <span className="hud__asof">as of {asof}</span>
      )}
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
