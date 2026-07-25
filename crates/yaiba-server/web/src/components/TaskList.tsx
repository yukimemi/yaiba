import { Fragment, useEffect, useRef } from "react";

import { shortLabel } from "../dates";
import type { SortKey } from "../filter";
import type { Scheduled, Task } from "../types";

interface Props {
  tasks: Task[];
  bySchedule: Map<string, Scheduled>;
  cursor: number;
  selected: Set<string>;
  editing: { id: string; value: string } | null;
  onEditChange: (value: string) => void;
  onEditKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Row index the unsaved new task occupies, or -1 when there is none. */
  draftIndex: number;
  draftValue: string;
  onDraftChange: (value: string) => void;
  onDraftKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  searchTerm: string;
  /** Rows currently playing the completion animation. */
  cutting: Set<string>;
  linkAnchor: string | null;
  onlyPane: boolean;
  emptyHint: string;
  sort: SortKey;
  paneRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}

const BOX = { todo: "[ ]", doing: "[~]", done: "[x]" } as const;
const PRIO = ["", "C", "B", "A"];

export function TaskList({
  tasks,
  bySchedule,
  cursor,
  selected,
  editing,
  onEditChange,
  onEditKey,
  draftIndex,
  draftValue,
  onDraftChange,
  onDraftKey,
  searchTerm,
  cutting,
  linkAnchor,
  onlyPane,
  emptyHint,
  sort,
  paneRef,
  onScroll,
}: Props) {
  const cursorRef = useRef<HTMLDivElement>(null);

  // Keep the cursor row on screen the way a terminal editor would —
  // scrolled into view, but never yanked to the middle.
  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, tasks.length]);

  const done = tasks.filter((t) => t.status === "done").length;

  // Two rows tall, matching the gantt's month + day header exactly, so
  // row N in the list and row N on the timeline share a baseline.
  const header = (
    <div className="list__head">
      <div className="list__summary">
        <span>
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </span>
        <span className="list__summary-right">
          {done} done · {sort} order
        </span>
      </div>
      {/* Same flex skeleton as a real row, so these labels sit over the
          columns they name. */}
      <div className="row row--head">
        <span className="row__num">#</span>
        <span className="row__caret"> </span>
        <span className="row__box">st</span>
        <span className="row__title">task</span>
        <span className="row__meta">due</span>
        <span className="row__prio">p</span>
      </div>
    </div>
  );

  const draftRow = (
    <div className="row row--cursor row--draft">
      <span className="row__num">+</span>
      <span className="row__caret">▸</span>
      <span className="row__box">[ ]</span>
      <input
        className="row__edit"
        value={draftValue}
        autoFocus
        spellCheck={false}
        placeholder="new task"
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onDraftKey}
        // Losing focus mid-entry would strand the row invisible; commit
        // whatever was typed.
        onBlur={() =>
          onDraftKey({
            key: "Escape",
            preventDefault: () => {},
            stopPropagation: () => {},
          } as React.KeyboardEvent<HTMLInputElement>)
        }
      />
    </div>
  );

  return (
    <div
      className={`pane pane--list${onlyPane ? " pane--only" : ""}`}
      ref={paneRef}
      onScroll={onScroll}
    >
      {header}
      {!tasks.length && draftIndex < 0 ? (
        <p className="empty">
          {emptyHint}
          <br />
          <b>o</b> to open a new task · <b>?</b> for keys
        </p>
      ) : (
        <div className="rows">
          {tasks.map((task, index) => {
            const sched = bySchedule.get(task.id);
            const isCursor = index === cursor && draftIndex < 0;
            const classes = [
              "row",
              `row--${task.status}`,
              isCursor && "row--cursor",
              selected.has(task.id) && "row--selected",
              sched?.blocked && "row--blocked",
              cutting.has(task.id) && "row--cut",
              searchTerm &&
                task.title.toLowerCase().includes(searchTerm.toLowerCase()) &&
                "row--match",
              linkAnchor === task.id && "row--selected",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <Fragment key={task.id}>
                {index === draftIndex && draftRow}
                <div className={classes} ref={isCursor ? cursorRef : undefined}>
                  <span className="row__num">{index + 1}</span>
                  {/* One stroke per dependency level: the graph's shape,
                      visible without leaving the list. */}
                  <span className="row__depth">
                    {"│".repeat(Math.min(sched?.depth ?? 0, 6))}
                  </span>
                  <span className="row__caret">▸</span>
                  <span className="row__box">{BOX[task.status]}</span>

                  {editing?.id === task.id ? (
                    <input
                      className="row__edit"
                      value={editing.value}
                      autoFocus
                      spellCheck={false}
                      onChange={(e) => onEditChange(e.target.value)}
                      onKeyDown={onEditKey}
                      onBlur={() =>
                        onEditKey({
                          key: "Enter",
                          preventDefault: () => {},
                          stopPropagation: () => {},
                        } as React.KeyboardEvent<HTMLInputElement>)
                      }
                    />
                  ) : (
                    <span className="row__title">{task.title || "…"}</span>
                  )}

                  {task.tags.map((tag) => (
                    <span key={tag} className="row__tag">
                      #{tag}
                    </span>
                  ))}
                  {task.progress > 0 && task.status !== "done" && (
                    <span className="row__meta">{task.progress}%</span>
                  )}
                  {sched?.critical && <span className="row__crit">◆</span>}
                  {task.due && (
                    <span
                      className={`row__meta row__meta--due${
                        sched?.overdue ? " row__meta--overdue" : ""
                      }`}
                    >
                      {shortLabel(task.due)}
                    </span>
                  )}
                  <span className="row__prio">{PRIO[task.priority] ?? ""}</span>
                </div>
              </Fragment>
            );
          })}
          {draftIndex >= tasks.length && draftRow}
        </div>
      )}
    </div>
  );
}
