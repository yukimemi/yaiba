import { Fragment, useEffect, useRef } from "react";

import type { Columns, DateField } from "../commands";
import {
  DATE_COLUMNS,
  dateDerived,
  dateLocked,
  dateValue,
} from "../dateColumns";
import { shortLabel } from "../dates";
import type { SortKey } from "../filter";
import type { Scheduled, Task } from "../types";

import type { Anchor } from "./DatePicker";

interface Props {
  tasks: Task[];
  bySchedule: Map<string, Scheduled>;
  cursor: number;
  selected: Set<string>;
  editing: { id: string; value: string; caret: "head" | "tail" } | null;
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
  /** `dates` swaps the right-hand markers for the four date columns. */
  columns: Columns;
  /** The cell whose picker is open, so it can stay lit under the panel. */
  picking: { id: string; field: DateField } | null;
  /** Click a date cell to open the calendar over it. */
  onOpenDate: (id: string, field: DateField, anchor: Anchor) => void;
  /** Rows folded individually, so the marker can show open vs closed. */
  collapsed: Set<string>;
  paneRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** Click a row to put the cursor on it. */
  onPick: (id: string) => void;
  /** Click the checkbox to complete. */
  onToggleDone: (id: string) => void;
  /** Click the ▾/▸ marker to fold. */
  onToggleFold: (id: string) => void;
  /** Double-click the title to edit it. */
  onEditTitle: (id: string) => void;
  /** Drag a row onto another to reorder. */
  onDropRow: (draggedId: string, targetId: string) => void;
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
  columns,
  picking,
  onOpenDate,
  collapsed,
  paneRef,
  onScroll,
  onPick,
  onToggleDone,
  onToggleFold,
  onEditTitle,
  onDropRow,
}: Props) {
  const cursorRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  // Keep the cursor row on screen the way a terminal editor would —
  // scrolled into view, but never yanked to the middle.
  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, tasks.length]);

  // Where the caret opens is the whole of what `i` and `a` mean here, so
  // it cannot be left to `autoFocus` — the browser puts it at the tail
  // either way. Keyed on the row and the requested end rather than on
  // `editing` itself, so typing (which changes `value` on every stroke)
  // doesn't drag the caret back.
  const editingId = editing?.id;
  const editingCaret = editing?.caret;
  useEffect(() => {
    const el = editRef.current;
    if (!el || !editingId) return;
    const at = editingCaret === "head" ? 0 : el.value.length;
    el.setSelectionRange(at, at);
  }, [editingId, editingCaret]);

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
        {columns === "dates" &&
          DATE_COLUMNS.map((col) => (
            <span
              key={col.field}
              className={`row__date${
                col.opensActuals ? " row__date--opens-actuals" : ""
              }`}
              title={col.title}
            >
              {col.head}
            </span>
          ))}
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
              sched?.summary && "row--summary",
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
                <div
                  className={classes}
                  ref={isCursor ? cursorRef : undefined}
                  // The row is the click target for "put the cursor
                  // here"; the controls inside it stop propagation so a
                  // click on the checkbox doesn't also move the cursor
                  // somewhere the user didn't ask for.
                  onMouseDown={() => onPick(task.id)}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", task.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const dragged = e.dataTransfer.getData("text/plain");
                    if (dragged && dragged !== task.id) {
                      onDropRow(dragged, task.id);
                    }
                  }}
                >
                  <span className="row__num">{index + 1}</span>
                  {/* Indent by position in the work breakdown, and mark
                      summaries so a collapsed one is obviously hiding
                      something rather than just being a short task. */}
                  <span className="row__indent">
                    {"  ".repeat(Math.min(sched?.level ?? 0, 8))}
                  </span>
                  <span
                    className={`row__fold${sched?.summary ? " row__fold--active" : ""}`}
                    onMouseDown={(e) => {
                      if (!sched?.summary) return;
                      e.stopPropagation();
                      onToggleFold(task.id);
                    }}
                  >
                    {sched?.summary ? (collapsed.has(task.id) ? "▸" : "▾") : " "}
                  </span>
                  <span className="row__caret">▸</span>
                  <span
                    className="row__box row__box--clickable"
                    title="complete / reopen"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      onToggleDone(task.id);
                    }}
                  >
                    {BOX[task.status]}
                  </span>

                  {editing?.id === task.id ? (
                    <input
                      className="row__edit"
                      ref={editRef}
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
                    <span
                      className="row__title"
                      onDoubleClick={() => onEditTitle(task.id)}
                    >
                      {task.title || "…"}
                    </span>
                  )}

                  {task.tags.map((tag) => (
                    <span key={tag} className="row__tag">
                      #{tag}
                    </span>
                  ))}
                  {(sched?.progress ?? task.progress) > 0 &&
                    task.status !== "done" && (
                      <span className="row__meta">
                        {sched?.progress ?? task.progress}%
                      </span>
                    )}
                  {sched?.summary && (
                    <span className="row__meta">
                      {sched.children}
                    </span>
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
                  {/* The plan and the record, side by side. A cell is a
                      button because it opens something; the ones the
                      scheduler owns are plain text, so they can't be
                      clicked into a value the next recompute erases. */}
                  {columns === "dates" &&
                    DATE_COLUMNS.map((col) => {
                      const value = dateValue(col.field, task, sched);
                      const locked = dateLocked(col.field, sched);
                      const classes = [
                        "row__date",
                        col.opensActuals && "row__date--opens-actuals",
                        col.actual && "row__date--actual",
                        dateDerived(col.field, task) && "row__date--derived",
                        !value && "row__date--empty",
                        locked && "row__date--locked",
                        picking?.id === task.id &&
                          picking.field === col.field &&
                          "row__date--picking",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      const text = value ? shortLabel(value) : "·";

                      return locked ? (
                        <span key={col.field} className={classes} title={locked}>
                          {text}
                        </span>
                      ) : (
                        <button
                          type="button"
                          key={col.field}
                          // How the keyboard finds this cell to anchor
                          // the calendar on — `cs` / `ce` / `ca` / `cA`
                          // open the same panel a click does.
                          data-date-cell={`${task.id}:${col.field}`}
                          className={classes}
                          title={col.title}
                          onMouseDown={(e) => {
                            // The row's own handler would move the
                            // cursor as well; do that here so it lands
                            // before the picker rather than behind it.
                            e.stopPropagation();
                            // And keep the focus this mousedown would
                            // otherwise put on the cell: the panel
                            // focuses itself as it mounts, the browser's
                            // default lands *after* that, and the
                            // calendar would open unable to hear a key.
                            e.preventDefault();
                            onPick(task.id);
                            const box = e.currentTarget.getBoundingClientRect();
                            onOpenDate(task.id, col.field, {
                              left: box.left,
                              top: box.top,
                              bottom: box.bottom,
                            });
                          }}
                        >
                          {text}
                        </button>
                      );
                    })}
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
