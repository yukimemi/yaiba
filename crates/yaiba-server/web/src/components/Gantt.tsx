import { useEffect, useRef, useState } from "react";

import type { Zoom } from "../commands";
import { addDays, diffDays, isWeekend, monthLabel, weekdayLabel } from "../dates";
import type { Dep, Scheduled, Task } from "../types";

/** Must match `--row-h` in styles.css. */
export const ROW_H = 26;

const DAY_W: Record<Zoom, number> = { day: 26, week: 9, month: 3.2 };

interface Props {
  tasks: Task[];
  bySchedule: Map<string, Scheduled>;
  deps: Dep[];
  cursor: number;
  today: string;
  zoom: Zoom;
  rangeStart: string;
  rangeEnd: string;
  onlyPane: boolean;
  paneRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** Draw the progress line (イナズマ線) against the reference date. */
  showProgressLine: boolean;
  onPick: (id: string) => void;
  /** Drag a bar sideways: pin a new start date. */
  onMoveBar: (id: string, days: number) => void;
  /** Drag a bar's right edge: change its duration. */
  onResizeBar: (id: string, days: number) => void;
  /** Drag from one bar's edge onto another: `from` must finish first. */
  onLinkBars: (from: string, to: string) => void;
  /** Click a dependency arrow to cut it. */
  onUnlinkDep: (dep: Dep) => void;
}

export function Gantt({
  tasks,
  bySchedule,
  deps,
  cursor,
  today,
  zoom,
  rangeStart,
  rangeEnd,
  onlyPane,
  paneRef,
  onScroll,
  showProgressLine,
  onPick,
  onMoveBar,
  onResizeBar,
  onLinkBars,
  onUnlinkDep,
}: Props) {
  const cursorTask = tasks[cursor];
  const dayW = DAY_W[zoom];

  /**
   * In-flight drag. Kept in state so the bar can preview where it will
   * land, and in a ref so the window listeners — which outlive any one
   * render — always read the current gesture.
   *
   * `days` is quantised to whole days as it goes: a gantt has no meaning
   * between two columns, and snapping while dragging makes the result
   * predictable rather than something to be corrected afterwards.
   */
  const [drag, setDrag] = useState<{
    kind: "move" | "resize" | "link";
    id: string;
    days: number;
    x: number;
    y: number;
    /** Cursor in body coordinates — only tracked for a link drag. */
    px: number;
    py: number;
    /** Row under the cursor, so it can be lit as the drop target. */
    over: string | null;
  } | null>(null);
  const dragRef = useRef<typeof drag>(null);
  dragRef.current = drag;
  const bodyRef = useRef<HTMLDivElement>(null);

  // The window listeners are installed once per drag, so they close
  // over whatever these props were at pointerdown. Each is memoised on
  // the polled data, so a refresh mid-drag replaces them — commit
  // through a ref and the release lands on the current schedule
  // instead of re-applying a stale one and filing an undo entry that
  // restores a value nobody holds any more.
  const commitRef = useRef({ onMoveBar, onResizeBar, onLinkBars });
  commitRef.current = { onMoveBar, onResizeBar, onLinkBars };
  const totalDays = Math.max(diffDays(rangeStart, rangeEnd) + 1, 1);
  const width = totalDays * dayW;
  const bodyH = Math.max(tasks.length * ROW_H, ROW_H);

  const x = (iso: string) => diffDays(rangeStart, iso) * dayW;
  const rowIndex = new Map(tasks.map((t, i) => [t.id, i]));

  const linking = drag?.kind === "link" ? drag : null;
  // Light a row only where a release would actually achieve something:
  // linking a task to itself is meaningless, and a second edge between
  // the same pair is refused on commit — better to say so beforehand
  // than to answer "already linked" after the gesture is spent.
  const dropTarget =
    linking &&
    linking.over &&
    linking.over !== linking.id &&
    !deps.some((d) => d.from === linking.id && d.to === linking.over)
      ? linking.over
      : null;

  // Follow the cursor horizontally so a task scheduled months out
  // doesn't require hunting for its bar.
  useEffect(() => {
    const pane = paneRef.current;
    const sched = cursorTask && bySchedule.get(cursorTask.id);
    if (!pane || !sched) return;
    const left = x(sched.start);
    const right = x(sched.end) + dayW;
    if (left < pane.scrollLeft + 40) {
      pane.scrollTo({ left: Math.max(left - 80, 0) });
    } else if (right > pane.scrollLeft + pane.clientWidth - 40) {
      pane.scrollTo({ left: right - pane.clientWidth + 120 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, cursorTask?.id, zoom, rangeStart]);

  useEffect(() => {
    if (!drag) return;
    const startX = drag.x;

    const onMove = (e: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      let px = current.px;
      let py = current.py;
      let over = current.over;
      if (current.kind === "link") {
        // Same hit-test as the release, so what lights up under the
        // cursor is exactly what a release would link to.
        const box = bodyRef.current?.getBoundingClientRect();
        px = box ? e.clientX - box.left : px;
        py = box ? e.clientY - box.top : py;
        const row = document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest("[data-task-id]");
        over = row?.getAttribute("data-task-id") ?? null;
      }
      setDrag({
        ...current,
        days: Math.round((e.clientX - startX) / dayW),
        x: startX,
        y: e.clientY,
        px,
        py,
        over,
      });
    };

    const onUp = (e: PointerEvent) => {
      const current = dragRef.current;
      setDrag(null);
      if (!current) return;

      if (current.kind === "link") {
        // Hit-test the release point rather than trusting `e.target`.
        // Touch and pen implicitly capture the pointer on whatever
        // received `pointerdown`, so `e.target` at release is the drag
        // handle itself — the link would silently never be made.
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const to = under
          ?.closest("[data-task-id]")
          ?.getAttribute("data-task-id");
        if (to && to !== current.id) {
          commitRef.current.onLinkBars(current.id, to);
        }
        return;
      }
      if (current.days === 0) return;
      const commit = commitRef.current;
      if (current.kind === "move") commit.onMoveBar(current.id, current.days);
      else commit.onResizeBar(current.id, current.days);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.kind, drag?.id, dayW]);

  const days: string[] = [];
  for (let i = 0; i < totalDays; i += 1) days.push(addDays(rangeStart, i));

  // Label density has to fall off with zoom or the header turns to mush.
  const dayStep = zoom === "day" ? 1 : zoom === "week" ? 7 : 0;
  const months = days.filter((d) => d.endsWith("-01") || d === rangeStart);

  return (
    <div
      className={`pane pane--gantt${onlyPane ? " pane--only" : ""}`}
      ref={paneRef}
      onScroll={onScroll}
    >
      <div className="gantt" style={{ width }}>
        <div className="gantt__head" style={{ width }}>
          {months.map((iso, i) => {
            const next = months[i + 1];
            const end = next ? x(next) : width;
            return (
              <div
                key={iso}
                className="gantt__month"
                style={{ left: x(iso), width: end - x(iso) }}
              >
                {monthLabel(iso)}
              </div>
            );
          })}
          {dayStep > 0 &&
            days.map((iso, i) =>
              i % dayStep === 0 ? (
                <div
                  key={iso}
                  className={[
                    "gantt__day",
                    isWeekend(iso) && "gantt__day--weekend",
                    iso === today && "gantt__day--today",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ left: x(iso), width: dayW * dayStep }}
                >
                  {zoom === "day"
                    ? `${Number(iso.slice(8))}${weekdayLabel(iso)}`
                    : Number(iso.slice(8))}
                </div>
              ) : null,
            )}
        </div>

        <div
          className={`gantt__body${linking ? " gantt__body--linking" : ""}`}
          ref={bodyRef}
          style={{ width, height: bodyH }}
        >
          {zoom === "day" &&
            days.map((iso) =>
              isWeekend(iso) ? (
                <div
                  key={iso}
                  className="gantt__weekend"
                  style={{ left: x(iso), width: dayW }}
                />
              ) : null,
            )}

          <div
            className={`gantt__today${showProgressLine ? "" : " gantt__today--plain"}`}
            style={{ left: x(today) }}
          />

          {tasks.map((task, index) => {
            const sched = bySchedule.get(task.id);
            if (!sched) return null;
            const left = x(sched.start);
            const barW = Math.max(
              (diffDays(sched.start, sched.end) + 1) * dayW - 2,
              3,
            );
              // A live drag shifts the preview; the commit happens on
              // release. Only the dragged bar moves — dependents settle
              // when the server recomputes.
              const dragging = drag?.id === task.id ? drag : null;
              const previewLeft =
                dragging?.kind === "move" ? left + dragging.days * dayW : left;
              const previewW =
                dragging?.kind === "resize"
                  ? Math.max(barW + dragging.days * dayW, dayW - 2)
                  : barW;

              return (
              <div
                key={task.id}
                data-task-id={task.id}
                className={`gantt__row${index === cursor ? " gantt__row--cursor" : ""}`}
                style={{ top: index * ROW_H }}
                onMouseDown={() => onPick(task.id)}
              >
                <div
                  className={[
                    "gantt__bar",
                    // A summary gets a bracket spanning its children
                    // rather than a bar of its own: it isn't work, it is
                    // the extent of the work inside it.
                    sched.summary && "gantt__bar--summary",
                    sched.critical && "gantt__bar--critical",
                    task.status === "done" && "gantt__bar--done",
                    sched.blocked && "gantt__bar--blocked",
                    sched.overdue && "gantt__bar--overdue",
                    dragging && "gantt__bar--dragging",
                    dropTarget === task.id && "gantt__bar--drop",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ left: previewLeft, width: previewW }}
                  onPointerDown={(e) => {
                    // A summary's dates are a consequence of its
                    // children; dragging it would be a lie the next
                    // recompute erases.
                    if (sched.summary || e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onPick(task.id);
                    setDrag({
                      kind: "move",
                      id: task.id,
                      days: 0,
                      x: e.clientX,
                      y: e.clientY,
                      px: 0,
                      py: 0,
                      over: null,
                    });
                  }}
                  title={`${task.title}\n${sched.start} → ${sched.end}${
                    sched.summary ? ` · ${sched.children} inside` : ""
                  }${
                    sched.slack_days > 0 ? `\nslack ${sched.slack_days}d` : ""
                  }`}
                >
                  <div
                    className="gantt__fill"
                    style={{
                      width: `${
                        task.status === "done" ? 100 : sched.progress
                      }%`,
                    }}
                  />
                </div>
                {/* Siblings of the bar, not children: the bar clips its
                    overflow to keep the progress fill inside its rounded
                    corners, and the link grip sits just past the right
                    edge — inside, it was clipped away entirely and could
                    be neither seen nor hit. */}
                {!sched.summary && (
                  <>
                    <span
                      className="gantt__handle gantt__handle--resize"
                      style={{ left: previewLeft + previewW - 6 }}
                      title="drag to change the duration"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setDrag({
                          kind: "resize",
                          id: task.id,
                          days: 0,
                          x: e.clientX,
                          y: e.clientY,
                          px: 0,
                          py: 0,
                          over: null,
                        });
                      }}
                    />
                    <span
                      className="gantt__handle gantt__handle--link"
                      style={{ left: previewLeft + previewW + 1 }}
                      title="drag onto another bar to make it wait for this one"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setDrag({
                          kind: "link",
                          id: task.id,
                          days: 0,
                          x: e.clientX,
                          y: e.clientY,
                          px: 0,
                          py: 0,
                          over: null,
                        });
                      }}
                    />
                  </>
                )}
                {/* Only in the gantt-only view: alongside the list the
                    titles are already there, and repeating them here
                    collides with the next bar. */}
                {onlyPane && (
                  <div
                    className="gantt__label"
                    style={{ left: left + barW + 6 }}
                  >
                    {task.title}
                  </div>
                )}
              </div>
            );
          })}

          <svg className="gantt__links" width={width} height={bodyH}>
            {deps.map((dep) => {
              const fromRow = rowIndex.get(dep.from);
              const toRow = rowIndex.get(dep.to);
              const fromSched = bySchedule.get(dep.from);
              const toSched = bySchedule.get(dep.to);
              // An edge to a filtered-out row has nothing to connect.
              if (
                fromRow === undefined ||
                toRow === undefined ||
                !fromSched ||
                !toSched
              ) {
                return null;
              }

              const x1 = x(fromSched.end) + dayW;
              const y1 = fromRow * ROW_H + ROW_H / 2;
              const x2 = x(toSched.start);
              const y2 = toRow * ROW_H + ROW_H / 2;
              const critical = fromSched.critical && toSched.critical;
              const focus =
                cursorTask?.id === dep.from || cursorTask?.id === dep.to;
              const suffix = focus ? "--focus" : critical ? "--critical" : "";

              // Enough room to turn once; otherwise step around the
              // rows rather than drawing back through the bars.
              const d =
                x2 - x1 >= 14
                  ? `M${x1} ${y1} H${x1 + 8} V${y2} H${x2 - 5}`
                  : `M${x1} ${y1} H${x1 + 8} V${
                      y1 + (y2 >= y1 ? ROW_H / 2 : -ROW_H / 2)
                    } H${x2 - 14} V${y2} H${x2 - 5}`;

              return (
                <g key={`${dep.from}-${dep.to}`}>
                  {/* An invisible fat stroke over the same path: a 1px
                      line is not something anyone can be asked to hit.
                      Drawn first so the two visible siblings below can
                      react to its hover. */}
                  <path
                    className="gantt__link-hit"
                    d={d}
                    onClick={() => onUnlinkDep(dep)}
                  >
                    <title>click to cut this dependency</title>
                  </path>
                  <path
                    className={`gantt__link ${suffix ? `gantt__link${suffix}` : ""}`}
                    d={d}
                  />
                  <polygon
                    className={`gantt__arrow ${
                      suffix ? `gantt__arrow${suffix}` : ""
                    }`}
                    points={`${x2},${y2} ${x2 - 5},${y2 - 3.5} ${x2 - 5},${y2 + 3.5}`}
                  />
                </g>
              );
            })}

            {/* The edge that does not exist yet. Without it a link drag
                is invisible: the grip is released somewhere and either
                an arrow appears or nothing does. */}
            {linking && (linking.px !== 0 || linking.py !== 0) && (
              <g className="gantt__draft">
                <path
                  className={`gantt__draft-line${
                    dropTarget ? " gantt__draft-line--armed" : ""
                  }`}
                  d={`M${x(bySchedule.get(linking.id)?.end ?? rangeStart) + dayW} ${
                    (rowIndex.get(linking.id) ?? 0) * ROW_H + ROW_H / 2
                  } L${linking.px} ${linking.py}`}
                />
                <circle
                  className={`gantt__draft-tip${
                    dropTarget ? " gantt__draft-tip--armed" : ""
                  }`}
                  cx={linking.px}
                  cy={linking.py}
                  r={dropTarget ? 4 : 2.5}
                />
              </g>
            )}

            {showProgressLine && (
              <polyline
                className="gantt__progress-line"
                points={progressLinePoints(tasks, bySchedule, x, dayW, today)}
              />
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}

/**
 * The progress line — イナズマ線.
 *
 * Starts on the reference date and, for each row, steps horizontally by
 * how far that task deviates from where it *should* be, then down to the
 * next row. Bulges right are ahead of plan, notches left are behind, and
 * a straight line means everything is exactly on schedule. The shape is
 * the report — project health without reading a number.
 *
 * The deviation is what matters, not the absolute position. Plotting
 * "how far along the bar is it" instead puts a task that finished last
 * week far to the *left* of the reference date, which reads as badly
 * late when it is the opposite. So each row is offset by
 * (actual − planned) × its own duration: a task finished on time lands
 * exactly on the line, and so does one that has not started and is not
 * yet due to.
 */
function progressLinePoints(
  tasks: Task[],
  bySchedule: Map<string, Scheduled>,
  x: (iso: string) => number,
  dayW: number,
  reference: string,
): string {
  const refX = x(reference);
  const points: string[] = [`${refX},0`];

  tasks.forEach((task, index) => {
    const sched = bySchedule.get(task.id);
    const top = index * ROW_H;
    const bottom = top + ROW_H;
    if (!sched) {
      points.push(`${refX},${bottom}`);
      return;
    }

    const spanDays = Math.max(diffDays(sched.start, sched.end) + 1, 1);
    // Where the plan says it should be by the reference date.
    const elapsed = diffDays(sched.start, reference) + 1;
    const planned = Math.min(Math.max(elapsed / spanDays, 0), 1);
    const actual = (task.status === "done" ? 100 : sched.progress) / 100;
    // Scaled by the task's own duration, so a week of slippage on a
    // 2-month task doesn't look like a week on a 3-day one.
    const reached = refX + (actual - planned) * spanDays * dayW;

    points.push(`${reached},${top}`, `${reached},${bottom}`);
  });

  points.push(`${refX},${tasks.length * ROW_H}`);
  return points.join(" ");
}
