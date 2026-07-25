import type { Mode } from "../mode";
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

      <span className="hud__spacer" />

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
