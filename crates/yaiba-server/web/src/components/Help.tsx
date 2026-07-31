import { t } from "../i18n";

interface Group {
  title: string;
  keys: [string, string][];
}

/**
 * The panel, in English, built fresh on every render.
 *
 * A module constant would be built once — under the old language — and
 * `:lang` would leave the help behind, which is exactly the screen you
 * open to find out how to change it back.
 *
 * The left column is never translated. `zm` is `zm`, and a help that
 * renamed the keys would be describing a different program. Neither is
 * a list of the words a command *accepts* (`day, week, month`): those
 * are typed, not read.
 */
const groups = (): Group[] => [
  {
    title: t("MOVE"),
    keys: [
      ["j / k", t("down / up")],
      ["gg / G", t("first / last")],
      ["^d / ^u", t("half page")],
      ["H / M / L", t("top / middle / bottom")],
      ["h / l", t("out / in — a fold, or a column under gd")],
      ["/ n N", t("search, next, previous")],
      ["tab", t("cycle split → list → gantt")],
    ],
  },
  {
    title: t("EDIT"),
    keys: [
      ["o / O", t("new task below / above, at this level")],
      ["i / I", t("edit the title (head)")],
      ["a / A", t("edit the title (tail)")],
      ["cc", t("clear the title and edit")],
      ["x", t("toggle done")],
      ["s", "cycle todo → doing → done"],
      ["dd", t("delete")],
      ["yy / p", t("yank / paste a copy")],
      ["J / K", t("move the row down / up, level and all")],
      ["u / ^r", t("undo / redo")],
    ],
  },
  {
    title: t("PLAN"),
    keys: [
      ["+ / -", t("duration ±1 day")],
      ["gp / gP", t("priority up / down")],
      ["( / )", t("progress ∓10%")],
      ["D", t("add a dependency")],
      ["X", t("remove a dependency")],
      ["[ / ]", t("gantt zoom out / in")],
      ["v", t("visual line select")],
      ["gd", t("date columns ⇄ compact")],
      ["gt", t("office mode ⇄ neon mode")],
    ],
  },
  {
    title: t("COLUMNS"),
    keys: [
      ["gd", t("date columns ⇄ compact")],
      ["h / l", t("walk the cells — arrows too")],
      ["j / k", t("keep the column, change the row")],
      ["⏎", t("edit the cell under the cursor")],
      ["h at the title", t("back to folding")],
    ],
  },
  {
    title: t("MOUSE"),
    keys: [
      ["click", t("put the cursor on a row")],
      ["click +", t("new task below, at this level")],
      ["click [ ]", t("complete / reopen")],
      ["click ▾", t("fold a summary")],
      [t("drag the divider"), t("resize the split · dbl-click resets")],
      [t("divider, focused"), t("← → or h l move it 2% · Home resets")],
      ["dbl-click", t("edit the title")],
      ["click owner", t("pick who it belongs to — in :dates")],
      ["drag row", t("reorder")],
      ["drag bar", t("move the start date")],
      ["drag ⟩ edge", t("change the duration")],
      ["drag ● onto", t("make that task wait for this one")],
      ["click arrow", t("cut that dependency")],
      ["◀ ▶ in the bar", t("reference date, a day at a time")],
      ["click the date", t("jump to one — or back to now")],
    ],
  },
  {
    title: t("BREAKDOWN"),
    keys: [
      [">> / <<", t("nest under the row above / move out")],
      ["l / h", t("open this fold / close it, or step out and close")],
      ["zm / zr", t("fold one level shallower / deeper")],
      ["zM / zR", t("fold to projects only / unfold all")],
      ["za", t("toggle this row · zo open · zc close")],
      ["zf / zF", t("focus this subtree / show everything")],
    ],
  },
  {
    title: t(": COMMANDS"),
    keys: [
      [":new ⟨t⟩", t("add a task")],
      [":due ⟨d⟩", "today, tom, mon, +3d, 8/14"],
      [":start ⟨d⟩", t("pin a start date")],
      [":end ⟨d⟩", t("land it on a date — sets the duration")],
      [":dur ⟨n⟩", t("duration in days")],
      [":prio ⟨n⟩", t("0 none … 3 high")],
      [":pr ⟨n⟩", t("progress percent")],
      [":tag +a -b", t("add / remove tags")],
      [":assign ⟨n⟩", t("hand it to somebody — bare clears")],
      [":notes ⟨t⟩", t("attach a note — bare clears · hover the ✎")],
      [":dep ⟨n⟩", t("wait for row n")],
      [":dep ⟨n⟩ +0", t("…and may start the same day")],
      [":undep ⟨n⟩", t("cut that dependency")],
      [":f ⟨q⟩", "tag:dev, @yuki / owner:yuki, unassigned, open, crit"],
      [":sort ⟨k⟩", "manual, due, prio, start, title, owner"],
      [":zoom ⟨z⟩", "day, week, month"],
      [":split ⟨n⟩", t("the list's percent of the width")],
    ],
  },
  {
    title: t(": ACTUALS"),
    keys: [
      [":astart ⟨d⟩", t("when work really began")],
      [":aend ⟨d⟩", t("when it really finished — none clears")],
      [":dates", t("plan vs actual, and an owner column — gd toggles")],
      [":cols ⟨c⟩", "compact, dates"],
    ],
  },
  {
    title: t("DATE PICKER"),
    keys: [
      ["cs / ce", t("calendar on the planned start / end")],
      ["ca / cA", t("calendar on the actual start / end")],
      ["click a cell", t("open the calendar over it")],
      ["hjkl / arrows", t("walk the grid")],
      ["[ / ]", t("previous / next month")],
      ["t", t("jump to the reference date")],
      ["x", t("clear it — not the planned end")],
      ["⏎ / esc", t("commit / close")],
    ],
  },
  {
    title: t("OWNER"),
    keys: [
      ["co", t("open the owner panel")],
      ["click owner", t("the same panel, from the column")],
      ["type", t("filter, or write a name that is new")],
      ["↑ / ↓", t("walk the names in use")],
      ["⏎ / esc", t("commit / close")],
      [":assign ⟨n⟩", t("set it without the panel — bare clears")],
    ],
  },
  {
    title: t("PEERS"),
    keys: [
      [":ticket", t("copy this replica's invite")],
      [":join ⟨t⟩", t("merge this project with that peer")],
    ],
  },
  {
    title: t("PROJECTS"),
    keys: [
      [":proj", t("pick one — click the name in the bar too")],
      [":proj ⟨n⟩", t("switch straight to it")],
      [":proj new ⟨n⟩", t("start one of your own")],
      [":proj rename ⟨n⟩", t("rename the current one")],
      [":proj forget ⟨n⟩", t("drop it from the list; database stays")],
      ["^r / ^d", t("in the picker: rename / forget")],
    ],
  },
  {
    title: t(": AS OF"),
    keys: [
      [":asof ⟨d⟩", t("see the plan as it stood then")],
      [":asof today", t("back to now")],
    ],
  },
  {
    title: t(": BREAKDOWN"),
    keys: [
      [":level ⟨n⟩", t("show down to level n (bare = all)")],
      [":parent ⟨n⟩", t("move under row n (bare = top level)")],
      [":only / :all", t("focus this subtree / clear")],
      [":theme ⟨t⟩", t("dark / light — bare toggles")],
      [":office", t("straight to office mode")],
      [":lang ⟨l⟩", t("en / ja — bare toggles")],
    ],
  },
];

interface Props {
  onClose: () => void;
}

export function Help({ onClose }: Props) {
  return (
    <div className="help" onClick={onClose}>
      <div className="help__panel" onClick={(e) => e.stopPropagation()}>
        <h1 className="help__title">{t("YAIBA 刃 — KEYS")}</h1>
        <div className="help__grid">
          {groups().map((group) => (
            <section key={group.title} className="help__group">
              <div className="help__head">{group.title}</div>
              {group.keys.map(([key, desc]) => (
                <div key={key} className="help__row">
                  <span className="help__key">{key}</span>
                  <span className="help__desc">{desc}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
        <p className="help__foot">
          {t(
            "Edits save as they happen. Dates accept today / tom / mon / +3d / 8-14. On the : line, tab completes and s-tab walks back. Press ? or esc to close.",
          )}
        </p>
      </div>
    </div>
  );
}
