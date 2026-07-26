interface Group {
  title: string;
  keys: [string, string][];
}

const GROUPS: Group[] = [
  {
    title: "MOVE",
    keys: [
      ["j / k", "down / up"],
      ["gg / G", "first / last"],
      ["^d / ^u", "half page"],
      ["H / M / L", "top / middle / bottom"],
      ["/ n N", "search, next, previous"],
      ["tab", "cycle split → list → gantt"],
    ],
  },
  {
    title: "EDIT",
    keys: [
      ["o / O", "new task below / above"],
      ["i a c", "edit the title"],
      ["x", "toggle done"],
      ["s", "cycle todo → doing → done"],
      ["dd", "delete"],
      ["yy / p", "yank / paste a copy"],
      ["J / K", "move the row down / up"],
      ["u / ^r", "undo / redo"],
    ],
  },
  {
    title: "PLAN",
    keys: [
      ["+ / -", "duration ±1 day"],
      ["gp / gP", "priority up / down"],
      ["( / )", "progress ∓10%"],
      ["D", "add a dependency"],
      ["X", "remove a dependency"],
      ["[ / ]", "gantt zoom out / in"],
      ["v", "visual line select"],
      ["gt", "office mode ⇄ neon mode"],
    ],
  },
  {
    title: "MOUSE",
    keys: [
      ["click", "put the cursor on a row"],
      ["click [ ]", "complete / reopen"],
      ["click ▾", "fold a summary"],
      ["dbl-click", "edit the title"],
      ["drag row", "reorder"],
      ["drag bar", "move the start date"],
      ["drag ⟩ edge", "change the duration"],
      ["drag ● onto", "make that task wait for this one"],
      ["click arrow", "cut that dependency"],
    ],
  },
  {
    title: "BREAKDOWN",
    keys: [
      [">> / <<", "nest under the row above / move out"],
      ["zm / zr", "fold one level shallower / deeper"],
      ["zM / zR", "fold to projects only / unfold all"],
      ["za", "toggle this row · zo open · zc close"],
      ["zf / zF", "focus this subtree / show everything"],
    ],
  },
  {
    title: ": COMMANDS",
    keys: [
      [":new ⟨t⟩", "add a task"],
      [":due ⟨d⟩", "today, tom, mon, +3d, 8/14"],
      [":start ⟨d⟩", "pin a start date"],
      [":dur ⟨n⟩", "duration in days"],
      [":prio ⟨n⟩", "0 none … 3 high"],
      [":pr ⟨n⟩", "progress percent"],
      [":tag +a -b", "add / remove tags"],
      [":dep ⟨n⟩", "wait for row n"],
      [":undep ⟨n⟩", "cut that dependency"],
      [":f ⟨q⟩", "tag:dev, open, crit, blocked, overdue"],
      [":sort ⟨k⟩", "manual, due, prio, start, title"],
      [":zoom ⟨z⟩", "day, week, month"],
    ],
  },
  {
    title: "PEERS",
    keys: [
      [":ticket", "copy this replica's invite"],
      [":join ⟨t⟩", "merge this project with that peer"],
    ],
  },
  {
    title: ": AS OF",
    keys: [
      [":asof ⟨d⟩", "see the plan as it stood then"],
      [":asof today", "back to now"],
    ],
  },
  {
    title: ": BREAKDOWN",
    keys: [
      [":level ⟨n⟩", "show down to level n (bare = all)"],
      [":parent ⟨n⟩", "move under row n (bare = top level)"],
      [":only / :all", "focus this subtree / clear"],
      [":theme ⟨t⟩", "dark / light — bare toggles"],
      [":office", "straight to office mode"],
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
        <h1 className="help__title">YAIBA 刃 — KEYS</h1>
        <div className="help__grid">
          {GROUPS.map((group) => (
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
          Edits save as they happen. Dates accept today / tom / mon / +3d /
          8-14. On the : line, tab completes and s-tab walks back. Press ? or
          esc to close.
        </p>
      </div>
    </div>
  );
}
