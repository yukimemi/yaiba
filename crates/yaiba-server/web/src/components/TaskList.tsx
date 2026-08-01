import { Fragment, useEffect, useRef } from "react";

import { cellColumns, type CellField } from "../cells";
import type { Columns, DateField } from "../commands";
import {
  DATE_COLUMNS,
  dateDerived,
  dateLocked,
  dateValue,
} from "../dateColumns";
import { diffDays, shortLabel } from "../dates";
import type { SortKey } from "../filter";
import { t } from "../i18n";
import type { Scheduled, Task } from "../types";

import type { Anchor } from "./DatePicker";

interface Props {
  tasks: Task[];
  bySchedule: Map<string, Scheduled>;
  cursor: number;
  selected: Set<string>;
  /**
   * The columns the visual selection covers, or null when there is none.
   *
   * With `compact` up this is always the single column, so a selection
   * paints the row exactly as it always did — the shading only has
   * somewhere narrower to go once `gd` gives it more than one column.
   */
  selectedCols: CellField[] | null;
  editing: { id: string; value: string; caret: "head" | "tail" } | null;
  onEditChange: (value: string) => void;
  onEditKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Row index the unsaved new task occupies, or -1 when there is none. */
  draftIndex: number;
  /** Depth the unsaved row will land at, so it is drawn at that indent. */
  draftLevel: number;
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
  /**
   * The column `h` / `l` last walked to, drawn on the cursor row only.
   *
   * Only marked when there is more than one column to be standing in:
   * with `compact` up the cell is always the title, and a box around it
   * would be a second cursor saying what `row--cursor` already says.
   */
  cell: CellField;
  /** The cell whose picker is open, so it can stay lit under the panel. */
  picking: { id: string; field: DateField } | null;
  /** Click a date cell to open the calendar over it. */
  onOpenDate: (id: string, field: DateField, anchor: Anchor) => void;
  /** The row whose owner panel is open, lit for the same reason. */
  pickingOwner: string | null;
  /** Click the owner cell to pick who it belongs to. */
  onOpenOwner: (id: string, anchor: Anchor) => void;
  /** Click the `+` on the cursor row for a sibling below it — what `o` does. */
  onNewBelow: (id: string) => void;
  /** Click the empty pane's prompt for the very first task. */
  onNewFirst: () => void;
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
  selectedCols,
  editing,
  onEditChange,
  onEditKey,
  draftIndex,
  draftLevel,
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
  cell,
  picking,
  onOpenDate,
  pickingOwner,
  onOpenOwner,
  onNewBelow,
  onNewFirst,
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

  // Whether the visual rectangle is the whole row. Computed once rather
  // than per row: it is a property of the selection, not of any task.
  const spanAllCols =
    !selectedCols || selectedCols.length >= cellColumns(columns).length;

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
          {tasks.length === 1
            ? t("1 task")
            : t("{n} tasks", { n: tasks.length })}
        </span>
        {/* The sort key is not translated: it is what `:sort` takes. */}
        <span className="list__summary-right">
          {t("{n} done", { n: done })} · {t("{k} order", { k: sort })}
        </span>
      </div>
      {/* Same flex skeleton as a real row, so these labels sit over the
          columns they name — which means the indent and fold cells too,
          empty though they are here. Without them the headings sat one
          `gap` to the left of the columns as soon as the row overflowed,
          because a heading row two cells short is not the same skeleton
          however much this comment says it is. */}
      <div className="row row--head">
        <span className="row__num">#</span>
        <span className="row__indent" />
        <span className="row__fold"> </span>
        <span className="row__caret"> </span>
        <span className="row__box">{t("st")}</span>
        <span className="row__lead">
          <span className="row__title">{t("task")}</span>
          <span className="row__meta">{t("due")}</span>
        </span>
        {columns === "dates" && (
          <span className="row__owner-col" title={t("who owns it")}>
            {t("owner")}
          </span>
        )}
        {columns === "dates" &&
          DATE_COLUMNS.map((col) => (
            <span
              key={col.field}
              className={`row__date${
                col.opensActuals ? " row__date--opens-actuals" : ""
              }`}
              title={t(col.title)}
            >
              {t(col.head)}
            </span>
          ))}
        <span className="row__prio">{t("p")}</span>
        {/* The `+` slot, so the headings sit over the columns they name —
            this row is the same flex skeleton as a real one. */}
        <span className="row__new" aria-hidden="true" />
      </div>
    </div>
  );

  const draftRow = (
    <div className="row row--cursor row--draft">
      <span className="row__num">+</span>
      {/* Same indent and fold columns a saved row draws, so the level the
          new task is being created at is visible while it is typed and
          the caret does not shift left when it commits. */}
      <span className="row__indent">
        {"  ".repeat(Math.min(draftLevel, 8))}
      </span>
      <span className="row__fold"> </span>
      <span className="row__caret">▸</span>
      <span className="row__box">[ ]</span>
      {/* In the same box a saved row puts its title in, though this row
          draws no columns after it for anything to misalign with. The
          skeleton is the claim this file has already been caught not
          keeping once: a row that says it matches the others has to
          match them before something downstream depends on it. */}
      <span className="row__lead">
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
      </span>
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
          {/* Clickable, because this is the one screen where the keyboard
              is not the *second* way in — with no rows there is nothing to
              hover a `+` on, so without this an empty project is a dead
              end for anyone who does not already know `o`. */}
          <button type="button" className="empty__new" onClick={onNewFirst}>
            <b>o</b> {t("to open a new task")}
          </button>{" "}
          · <b>?</b> {t("for keys")}
        </p>
      ) : (
        <div className="rows">
          {tasks.map((task, index) => {
            const sched = bySchedule.get(task.id);
            // Days past the due date, measured due → computed finish — the
            // same comparison the `overdue` flag itself is computed from.
            // How late, not just *that* it is late: the amber alone says
            // "trouble" but not how much, and the number is what a triage
            // reads first.
            const lateDays =
              sched?.overdue && task.due ? diffDays(task.due, sched.end) : 0;
            const isCursor = index === cursor && draftIndex < 0;
            /**
             * Is the cell cursor standing here?
             *
             * Gated on `dates` as well as on the row, because in compact
             * there is only one cell and a mark on it would be a second
             * cursor for the same position — see the `cell` prop.
             */
            const atCell = (field: CellField) =>
              isCursor && columns === "dates" && cell === field;
            /**
             * Is this cell inside the visual rectangle?
             *
             * Only when the rectangle is narrower than the row. A
             * selection covering every column — `V`, or anything at all
             * in `compact` — is drawn as the row shading it has always
             * been, because shading six cells edge to edge and shading
             * the row are the same picture, and the row is the cheaper
             * one to paint.
             */
            const rowSelected = selected.has(task.id);
            const inCellSel = (field: CellField) =>
              rowSelected &&
              !spanAllCols &&
              !!selectedCols?.includes(field);
            const classes = [
              "row",
              `row--${task.status}`,
              sched?.summary && "row--summary",
              isCursor && "row--cursor",
              rowSelected && spanAllCols && "row--selected",
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
                    title={t("complete / reopen")}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      onToggleDone(task.id);
                    }}
                  >
                    {BOX[task.status]}
                  </span>

                  {/* The title and everything that trails it live in one
                      box, so the columns after it start at the same place
                      on every row.

                      They did not, and the reason is that this run has no
                      fixed length: a chip, any number of tags, a percent,
                      a child count, `◆`, a due date. While the title has
                      slack it absorbs the difference and the columns look
                      like columns; once it runs out, each row's columns
                      sit wherever that row's annotations left them. At a
                      411px pane with `gd` up, `p` measured 435, 486, 559
                      and 508 on four rows — and no per-cell placeholder
                      can fix it, because tags are unbounded.

                      So the variability is contained instead of
                      counted. Overflow inside here clips the annotations,
                      which is the right thing to lose: they are a gloss
                      on the row, and the columns are what you were
                      reading down.

                      One divergence is left, and on purpose: `row__indent`
                      sits outside this box, because the checkbox indents
                      with the row and moving the indent in here would
                      un-indent it. So once this box has collapsed
                      entirely, a nested row's columns still sit 1ch per
                      level right of a root row's. Bounded and legible,
                      where the annotation run was unbounded — fixing it
                      means deciding whether depth or alignment gives way
                      first, which is a design question and not this
                      one. */}
                  <span className="row__lead">
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
                      className={`row__title${atCell("title") ? " row__cell" : ""}${
                        inCellSel("title") ? " row__cell--sel" : ""
                      }`}
                      onDoubleClick={() => onEditTitle(task.id)}
                    >
                      {task.title || "…"}
                    </span>
                  )}

                  {/* A note has no column and no panel, so this marker is
                      the only sign the row carries one — and hovering it
                      the only way to read one. Muted like the meta run it
                      sits in: a note is a gloss, not a signal, and the
                      palette is spent on things that mean trouble. */}
                  {task.notes && (
                    <span className="row__note" title={task.notes}>
                      ✎
                    </span>
                  )}

                  {/* Who, then what: the owner sits ahead of the tags
                      because it answers the question the tags cannot,
                      and it takes no colour of its own — the palette is
                      spent on things that mean trouble, and an owner is
                      not one.

                      It gives way to the `owner` column below when the
                      date columns are up. The chip is what keeps "whose
                      is this" readable without a mode change; the column
                      is what makes a roster scannable down the page. Both
                      at once is the same name twice on one row. */}
                  {columns !== "dates" && task.assignee && (
                    <span className="row__owner" title={t("assigned to {who}", {
                      who: task.assignee,
                    })}>
                      @{task.assignee}
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
                  {/* The one mark on a row that is derived rather than
                      entered, so hovering it is the only way to ask what
                      it is without opening the help. */}
                  {sched?.critical && (
                    <span
                      className="row__crit"
                      title={t("on the critical path — no slack, so a day here is a day on the project")}
                    >
                      ◆
                    </span>
                  )}
                  {task.due && (
                    <span
                      className={`row__meta row__meta--due${
                        sched?.overdue ? " row__meta--overdue" : ""
                      }`}
                      title={
                        lateDays > 0
                          ? t("projected to finish {n}d past its due date", {
                              n: lateDays,
                            })
                          : undefined
                      }
                    >
                      {shortLabel(task.due)}
                      {lateDays > 0 && ` +${lateDays}d`}
                    </span>
                  )}
                  </span>
                  {/* Fixed width, so a roster reads straight down the
                      page — the one thing the chip cannot do. A button,
                      like the editable date cells beside it: nothing here
                      is derived, so there is no value for a recompute to
                      erase, and the panel it opens is the mouse's only
                      way to this field. */}
                  {columns === "dates" && (
                    <button
                      type="button"
                      // How `co` finds this cell to anchor the panel on,
                      // matching `data-date-cell`.
                      data-owner-cell={task.id}
                      className={[
                        "row__owner-col",
                        !task.assignee && "row__owner-col--empty",
                        pickingOwner === task.id && "row__owner-col--picking",
                        atCell("owner") && "row__cell",
                        inCellSel("owner") && "row__cell--sel",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      title={
                        task.assignee
                          ? t("assigned to {who}", { who: task.assignee })
                          : t("nobody has taken it yet")
                      }
                      onMouseDown={(e) => {
                        // The row's own handler would move the cursor as
                        // well; do it here so it lands before the panel
                        // rather than behind it. And keep the focus this
                        // mousedown would otherwise take: the panel
                        // focuses its input as it mounts, the browser's
                        // default lands *after* that, and the box would
                        // open unable to hear a key.
                        e.stopPropagation();
                        e.preventDefault();
                        onPick(task.id);
                        const box = e.currentTarget.getBoundingClientRect();
                        onOpenOwner(task.id, {
                          left: box.left,
                          top: box.top,
                          bottom: box.bottom,
                        });
                      }}
                    >
                      {task.assignee || "·"}
                    </button>
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
                        atCell(col.field) && "row__cell",
                        inCellSel(col.field) && "row__cell--sel",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      const text = value ? shortLabel(value) : "·";

                      return locked ? (
                        <span
                          key={col.field}
                          className={classes}
                          title={t(locked)}
                        >
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
                          title={t(col.title)}
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
                  {/* Visible on the cursor row only, the way the project
                      palette keeps its row actions to one row: on every row
                      this is a column of plus signs and the eye stops
                      reading the tasks. It means exactly what `o` means — a
                      sibling below this one, at this one's level — so the
                      indent it will land at is the indent you are looking
                      at.

                      The slot is held open on *every* row, though, the same
                      way `row__fold` draws a space for a row that cannot
                      fold. Rendering it only on the cursor row took 2ch and
                      a gap out of that row's width, so every column to the
                      left of here sat 22px further left than on its
                      neighbours — and the whole right-hand side of the list
                      twitched as `j` moved the cursor down it. In the
                      `:dates` view, where these are columns of a table,
                      that is the defect that matters. */}
                  {isCursor ? (
                    <button
                      type="button"
                      className="row__new"
                      title={t("new task below, at this level — o")}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        onNewBelow(task.id);
                      }}
                    >
                      +
                    </button>
                  ) : (
                    <span className="row__new" aria-hidden="true" />
                  )}
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
