import { t } from "../i18n";

/**
 * `[key, description]`, or `[key, description, class]` when the left
 * column has to be drawn in the colour the mark wears on a row.
 *
 * The class exists so the legend can name a colour without writing one
 * down. `magenta` is only true in neon mode — office mode swaps
 * `--blood` to red and `--edge` to blue — so a line reading "magenta
 * means critical path" is wrong for half the users, and wrong in
 * exactly the mode a status meeting is looking at. Painting the mark
 * itself with the same variable the row uses leaves nothing to go out
 * of date: `gt` recolours the legend and the rows together.
 */
type Row = [string, string] | [string, string, string];

interface Group {
  title: string;
  keys: Row[];
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
      ["i / I", t("edit the cell — the title at the head")],
      ["a / A", t("edit the cell — the title at the tail")],
      ["cc", t("edit the cell — the title, cleared first")],
      ["x / dl", t("clear the cell — on the title, same as cc")],
      ["<space>", t("toggle done")],
      ["s", "cycle todo → doing → done"],
      ["dd", t("delete the row")],
      ["yy / Y", t("yank rows — p pastes copies of them")],
      ["y / d", t("in v: yank / clear the cells")],
      ["y / d", t("in V: yank / delete the rows")],
      ["p", t("put the last yank down — rows or cells")],
      ["P", t("put rows above the cursor — rows only")],
      ["J / K", t("move the row down / up, level and all")],
      ["u / ^r", t("undo / redo")],
    ],
  },
  {
    title: t("PLAN"),
    keys: [
      ["+ / -", t("duration ±1 day")],
      [". / ,", t("start ±1 day — the bar moves")],
      ["gp / gP", t("priority up / down")],
      ["( / )", t("progress ∓10%")],
      ["D", t("add a dependency")],
      ["X", t("remove a dependency")],
      ["[ / ]", t("gantt zoom out / in")],
      ["T", t("scroll the timeline to the reference date")],
      ["v / V", t("select cells / whole rows")],
      ["gd", t("date columns ⇄ compact")],
      ["gt", t("office mode ⇄ neon mode")],
      ["gs", t("super mode ⇄ neon mode")],
      ["gc", t("colours — presets, and every slot")],
    ],
  },
  {
    title: t("COLUMNS"),
    keys: [
      ["gd", t("date columns ⇄ compact")],
      ["h / l", t("walk the cells — arrows too")],
      ["j / k", t("keep the column, change the row")],
      ["⏎ / i / I / a / A / cc", t("edit the cell under the cursor")],
      ["v h l j k", t("select a rectangle of cells")],
      ["y then p", t("copy that rectangle somewhere else")],
      ["h at the title", t("back to folding")],
    ],
  },
  {
    title: t("MOUSE"),
    keys: [
      ["click", t("put the cursor on a row")],
      ["right-click", t("the keys no other gesture reaches")],
      ["⇧ right-click", t("the browser's own menu")],
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
    /* The marks a row can grow, which are the one thing on screen with
       no key to look up: every other group here answers "what does this
       do", and this one answers "what is this". `◆` was the case that
       needed it — it appears only on zero-slack rows, says nothing on
       hover until now, and the schedule that puts it there is computed
       rather than typed, so there is no command to find it under. */
    title: t("MARKS"),
    keys: [
      ["◆", t("critical path — zero slack"), "help__key--crit"],
      ["✎", t("has a note — hover it"), "help__key--note"],
      ["8/14", t("a due date — this colour is overdue"), "help__key--due"],
      ["▸ / ▾", t("a summary, folded / open")],
      ["[ ] [x]", t("todo / done — click it")],
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
      [":title ⟨t⟩", t("rename — the whole selection")],
      [":notes ⟨t⟩", t("attach a note — bare clears · hover the ✎")],
      [":dep ⟨n⟩", t("wait for row n")],
      [":dep ⟨n⟩ +0", t("…and may start the same day")],
      [":undep ⟨n⟩", t("cut that dependency")],
      [":f ⟨q⟩", "tag:dev, @yuki / owner:yuki, unassigned, open, crit, late"],
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
      [":join ⟨t⟩", t("open their tasks as a project of its own")],
      [":merge ⟨t⟩", t("mix both task sets together (not undoable)")],
      [":leave", t("cut this project loose from its peers")],
    ],
  },
  {
    title: t("CALENDAR"),
    keys: [
      [":gcal push", t("write this project's plan to Google Calendar")],
      // A shell command in a keys column, because it is the half that
      // cannot be typed here: the consent screen needs a browser and a
      // listener on this machine. Without it a first `:gcal push` is a
      // refusal, and this is where somebody looks for what to do about it.
      ["yaiba gcal login", t("first, in a terminal — once per machine")],
    ],
  },
  {
    /* The project's own working calendar — a different thing from the
       group above it, which writes to Google's. Named for the week
       rather than for the word `calendar` so the two are not read as
       one feature with two halves. */
    title: t("WORK WEEK"),
    keys: [
      [":cal", t("what the calendar says — it only reports")],
      [":cal on / off", t("durations in working days / calendar days")],
      // The words themselves, like `:f` and `:sort` above: these are
      // typed, not read, and a translated `mon-fri` would not work.
      [":cal week ⟨w⟩", "mon-fri, mon-sat, 1111100"],
      [":cal region ⟨r⟩", "none, jp"],
      [":cal holiday ⟨d⟩", t("a day off — a name after it, if it has one")],
      [":cal workday ⟨d⟩", t("work it after all")],
      [":cal clear ⟨d⟩", t("forget that day, back to the week")],
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
      [":theme ⟨t⟩", t("dark / light / super — bare toggles office")],
      [":office", t("straight to office mode")],
      [":super", t("every effect at maximum — bare toggles")],
      [":colors", t("the same panel — :settings works too")],
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
              {/*
                Keyed by position, not by the key column. Two rows in one
                group can share a left column and mean different things —
                `y / d` answers one way under `v` and another under `V` —
                and keying on the string made those two siblings collide.
                The list is rebuilt whole on every render and never
                reorders, so the index is the stable identity here.
              */}
              {group.keys.map(([key, desc, cls], i) => (
                <div key={i} className="help__row">
                  <span className={cls ? `help__key ${cls}` : "help__key"}>
                    {key}
                  </span>
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
