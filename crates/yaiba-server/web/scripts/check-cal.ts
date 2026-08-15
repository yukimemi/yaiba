/**
 * The working calendar: what `:cal` may write, and what the business-day
 * arithmetic promises the preview and the commit will agree on.
 *
 * Four things live here, none of them visible to `tsc`:
 *
 * - **A bare `:cal` writes nothing.** It is the word somebody types to
 *   find out what the calendar is, and every verb under it moves every
 *   bar in the project. `:gcal` learned this once already; the cost of
 *   getting it wrong is higher here, because there is no undo — the
 *   stack replays task ops and a calendar change is not one.
 * - **Each verb reaches its own key, and an unknown one reaches
 *   nothing.** The patch is sparse on purpose (an omitted key is left
 *   alone by the server, so a peer's edit is not overwritten), which
 *   means a verb writing the wrong key writes a *valid* patch for
 *   something nobody asked to change.
 * - **`advanceWork` and `countWork` are inverses, and are the calendar
 *   arithmetic in `days` mode.** `:end`, a pinned lag, a bar drag and
 *   its preview are all built out of these two, so the round trip is
 *   the property that keeps what you see and what you commit the same
 *   date. The `days`-mode identity is the upgrade promise: with the
 *   default calendar not one bar may move.
 * - **The off-day band survives office mode.** `.gantt__off` is drawn
 *   as a 1.8% white wash, which over a white background is nothing —
 *   the light theme has to override it, and did once for
 *   `.gantt__weekend` before the class was renamed. Same trick as
 *   `check-flash.ts`: a stylesheet rule asserted without a browser.
 *
 * Run by `web-build`, so it gates every PR through `web.yml`.
 */

import { readFileSync } from "node:fs";

import {
  COMMANDS,
  calendarReport,
  moveLanding,
  resizeDuration,
  runCommand,
  type CommandContext,
} from "../src/commands.ts";
import { startCompletion } from "../src/completion.ts";
import {
  addDays,
  advanceWork,
  countWork,
  diffDays,
  holidayName,
  isOffDay,
  snapBack,
  snapForward,
} from "../src/dates.ts";
import {
  DEFAULT_CALENDAR,
  type AppData,
  type Calendar,
  type Scheduled,
} from "../src/types.ts";

let ran = 0;
let failures = 0;

function check(label: string, got: string, want: string): void {
  ran++;
  if (got === want) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures++;
  console.error(`FAIL  ${label}\n        got  ${got}\n        want ${want}`);
}

// ---- fixtures ---------------------------------------------------------
//
// Golden Week 2026, which is the week this feature exists for: 05-01 is
// a Friday, 05-02 and 05-03 the weekend, 05-04 みどりの日, 05-05
// こどもの日, and 05-06 the substitute for 憲法記念日 falling on the
// Sunday. Six days off in a row, so a one-day task starting on the
// Friday finishes on Thursday 05-07 — a gap no hand-written fixture
// would think to invent, and exactly the case a calendar is bought for.
//
// 05-03 is in the list even though the week mask already says Sunday:
// `Calendar::off_days` sends a holiday landing on a weekend because it
// has a *name*, and the name is what the header shows. It changes no
// date, which is the point of having it here — it must not.
//
// 05-09 is a Saturday somebody marked as worked, which is the other
// direction and the one that catches a `workdays` list being ignored.

const WORK: Calendar = {
  mode: "workdays",
  week: [true, true, true, true, true, false, false],
  region: "jp",
  holidays: {
    "2026-05-03": "憲法記念日",
    "2026-05-04": "みどりの日",
    "2026-05-05": "こどもの日",
    "2026-05-06": "振替休日",
  },
  workdays: ["2026-05-09"],
};

/** The default: calendar days, and every date here is one. */
const DAYS = DEFAULT_CALENDAR;

function state(calendar: Calendar): AppData {
  // No tasks: nothing about `:cal` reads one. Cast rather than built,
  // the way `check-gcal.ts` does — the fields left out are the ones a
  // filled-in fixture would invite reading.
  return {
    tasks: [],
    deps: [],
    schedule: { tasks: [], end: "2026-05-01" },
    today: "2026-05-01",
    as_of: false,
    node_id: "test",
    calendar,
  } as unknown as AppData;
}

const ctx: CommandContext = {
  data: state(WORK),
  visible: [],
  current: null,
  selection: [],
  projects: ["work"],
};

/** The whole result, flattened — so a stray extra action shows up too. */
function run(line: string): string {
  const r = runCommand(line, ctx);
  if (!r) return "nothing";
  if (r.error) return `error: ${r.error}`;
  const parts: string[] = [];
  if (r.cal) parts.push(`cal ${JSON.stringify(r.cal)}`);
  if (r.ops?.length) parts.push(`ops×${r.ops.length}`);
  if (r.ui) parts.push("ui");
  if (r.peer) parts.push("peer");
  if (r.project) parts.push("project");
  if (r.gcal) parts.push("gcal");
  if (r.message) parts.push(`say ${r.message}`);
  return parts.length ? parts.join(" | ") : "nothing";
}

// ---- the bare verb reports, and only reports --------------------------

check(
  "a bare :cal says what the calendar is",
  run("cal"),
  "say calendar: workdays · week mon-fri · holidays jp · 4 off / 1 worked in view",
);

check(
  "and writes nothing at all",
  String(runCommand("cal", ctx)?.cal ?? "none"),
  "none",
);

// The report is the syntax: `mon-fri` is a word `:cal week` accepts, so
// what is read back can be typed back. A mask with no name comes back as
// the digits, which is also typeable.
check(
  "an unnamed week reports as a mask, monday first",
  calendarReport({ ...WORK, week: [true, true, false, true, true, false, false] }),
  "calendar: workdays · week 1101100 · holidays jp · 4 off / 1 worked in view",
);

// ---- each verb reaches its own key ------------------------------------

check("on turns the mode over", run("cal on"), 'cal {"mode":"workdays"} | say durations count working days');
check("off turns it back", run("cal off"), 'cal {"mode":"days"} | say durations count calendar days');

check(
  "week takes a name",
  run("cal week mon-sat"),
  'cal {"week":[true,true,true,true,true,true,false]} | say work week: mon-sat',
);
check(
  "week takes a mask, monday first",
  run("cal week 1111001"),
  'cal {"week":[true,true,true,true,false,false,true]} | say work week: 1111001',
);
check(
  "region names a table",
  run("cal region jp"),
  'cal {"region":"jp"} | say holiday table: jp',
);
check(
  "region none keeps the days somebody typed",
  run("cal region none"),
  'cal {"region":"none"} | say no holiday table — marked days stay',
);
check(
  "holiday takes a date and the rest of the line as its name",
  run("cal holiday 2026-05-01 創立記念日"),
  'cal {"days":{"2026-05-01":"創立記念日"}} | say 2026-05-01 is off: 創立記念日',
);
check(
  "an unnamed holiday is still a holiday",
  run("cal holiday 2026-05-01"),
  'cal {"days":{"2026-05-01":true}} | say 2026-05-01 is off',
);
check(
  "workday is the other direction",
  run("cal workday 2026-05-09"),
  'cal {"days":{"2026-05-09":false}} | say 2026-05-09 is a working day',
);
// `null`, not an absent key: the patch leaves out what it does not mean,
// so the only way to erase a mark is to send the erasure. Dropping the
// key here would make `:cal clear` a command that reports success and
// changes nothing.
check(
  "clear sends the erasure",
  run("cal clear 2026-05-09"),
  'cal {"days":{"2026-05-09":null}} | say 2026-05-09 is back to the week',
);

// The dates are `parseDateExpr`'s, the same grammar `:due` takes —
// a second one for the calendar would be two answers to one question.
check(
  "a relative date is understood here too",
  run("cal holiday +1d"),
  'cal {"days":{"2026-05-02":true}} | say 2026-05-02 is off',
);

// ---- and nothing else writes anything ---------------------------------

check(
  "an unknown verb writes nothing, and lists what would",
  run("cal nope"),
  "error: usage: :cal on|off|week|region|holiday|workday|clear  (bare :cal reports)",
);
// The verb this one used to be. A replica that still speaks `jp` must be
// refused rather than quietly routed: `:cal jp off` reaching the region
// key would turn the table off on the word `off`.
check(
  "the old jp verb is not a verb",
  run("cal jp on"),
  "error: usage: :cal on|off|week|region|holiday|workday|clear  (bare :cal reports)",
);
check(
  "an unknown region writes nothing",
  run("cal region us"),
  "error: usage: :cal region none|jp",
);
check(
  "a week that never works is refused, and said why",
  run("cal week 0000000"),
  "error: a week with no working day is not a calendar",
);
check(
  "a week that is not seven digits is refused",
  run("cal week sometimes"),
  "error: usage: :cal week mon-fri|mon-sat|1111100  (seven digits, monday first)",
);
check(
  "a date that does not parse writes nothing",
  run("cal holiday nope"),
  "error: bad date: nope",
);
check(
  "a name on a verb that takes none is refused",
  run("cal workday 2026-05-09 みどりの日"),
  "error: usage: :cal holiday ⟨date⟩ [name] · :cal workday ⟨date⟩ · :cal clear ⟨date⟩",
);
check(
  "a mark with no date is refused",
  run("cal clear"),
  "error: usage: :cal holiday ⟨date⟩ [name] · :cal workday ⟨date⟩ · :cal clear ⟨date⟩",
);
check("on takes no argument", run("cal on now"), "error: usage: :cal on  (or :cal off)");

// A calendar change is never also a task edit: it would land on the undo
// stack beside ops that `u` can take back, and half a step is worse than
// none. Every verb, refusals included — a refusal that filed an op would
// be the worst of the three.
const CAL_LINES = [
  "cal",
  "cal on",
  "cal off",
  "cal week mon-sat",
  "cal week 0000000",
  "cal region jp",
  "cal region us",
  "cal holiday 2026-05-01 創立記念日",
  "cal workday 2026-05-09",
  "cal clear 2026-05-09",
  "cal nope",
];
check(
  "no verb files a task op",
  CAL_LINES.map((text) => runCommand(text, ctx)?.ops?.length ?? 0).join(","),
  CAL_LINES.map(() => 0).join(","),
);

// ---- completion offers what works, per branch -------------------------

const spec = COMMANDS.find((c) => c.name === "cal");
check("cal is in the completion table", String(Boolean(spec)), "true");

const args = (n: number, words: string[]) =>
  (spec?.args?.({ data: ctx.data, projects: ctx.projects }, n, words) ?? []).join(",");

check(
  "the verbs are offered, all of them",
  args(1, ["cal"]),
  "on,off,week,region,holiday,workday,clear",
);
check("week offers the named weeks", args(2, ["cal", "week"]), "mon-fri,mon-sat");
check("region offers the tables", args(2, ["cal", "region"]), "none,jp");
check(
  "a mark offers dates, and not the word that clears one",
  args(2, ["cal", "holiday"]),
  "today,tomorrow,yesterday,mon,tue,wed,thu,fri,sat,sun,+1d,+1w,+1m",
);
// The branches with no second word offer none, rather than the union of
// every branch: a menu is a promise that the word works.
check("on has nothing to offer after it", args(2, ["cal", "on"]), "");
check("a holiday's name is typed, not offered", args(3, ["cal", "holiday", "5/1"]), "");

// Through the real completion path, which is what proves the words reach
// the spec at all — the position alone cannot tell these two apart.
const line = (text: string) =>
  (startCompletion(text, { data: ctx.data, projects: ctx.projects })?.items ?? []).join(",");
check("tab after :cal week narrows to weeks", line("cal week m"), "mon-fri,mon-sat");
check("tab after :cal region narrows to tables", line("cal region n"), "none");

// ---- what is a day off ------------------------------------------------

check(
  "a weekday is worked",
  String(isOffDay("2026-05-01", WORK)),
  "false",
);
check("a saturday is not", String(isOffDay("2026-05-02", WORK)), "true");
check("nor is a holiday", String(isOffDay("2026-05-04", WORK)), "true");
check(
  "a marked working day beats the week mask",
  String(isOffDay("2026-05-09", WORK)),
  "false",
);
check(
  "the holiday's name is the tooltip",
  holidayName("2026-05-06", WORK) ?? "none",
  "振替休日",
);
check("a weekend has no name", holidayName("2026-05-02", WORK) ?? "none", "none");
// A holiday on a Sunday is a name on a day that was already off. It has
// to reach the tooltip and it has to change nothing else — counting it
// as a working day, or as a second day off, would both show up as a
// duration one day out.
check("a holiday on a sunday is still named", holidayName("2026-05-03", WORK) ?? "none", "憲法記念日");
check("and is still just one day off", String(countWork("2026-05-01", "2026-05-07", WORK)), "1");

// The mask is Monday-first and `Date.getDay()` is Sunday-first, so an
// asymmetric week is the shape that catches the shift being dropped: a
// Sunday-first reading of this mask would call Tuesday off and Wednesday
// worked, which is the same count of days and the wrong two.
const WED_OFF: Calendar = {
  ...WORK,
  week: [true, true, false, true, true, false, false],
  holidays: {},
  workdays: [],
};
check("monday first: wednesday is the day off", String(isOffDay("2026-05-06", WED_OFF)), "true");
check("monday first: tuesday is worked", String(isOffDay("2026-05-05", WED_OFF)), "false");
check("monday first: monday is worked", String(isOffDay("2026-05-04", WED_OFF)), "false");

// A mask nobody can work is no opinion rather than "never": a peer can
// sync one, and a calendar that shades every column is a plan with
// nowhere to put anything.
const BROKEN: Calendar = { ...WORK, week: [false, false, false, false, false, false, false], holidays: {}, workdays: [] };
check("a week of nothing shades nothing", String(isOffDay("2026-05-02", BROKEN)), "false");

// ---- the arithmetic ---------------------------------------------------

check("a working day snaps to itself", snapForward("2026-05-01", WORK), "2026-05-01");
check(
  "and golden week snaps all the way through",
  snapForward("2026-05-02", WORK),
  "2026-05-07",
);
check(
  "one working day after the friday is the thursday",
  advanceWork("2026-05-01", 1, WORK),
  "2026-05-07",
);
check(
  "zero working days is the snap",
  advanceWork("2026-05-02", 0, WORK),
  "2026-05-07",
);
check(
  "a marked saturday is a step like any other",
  advanceWork("2026-05-08", 2, WORK),
  "2026-05-11",
);
check(
  "and backwards over the same six days",
  advanceWork("2026-05-07", -1, WORK),
  "2026-05-01",
);
check("golden week is one working day wide", String(countWork("2026-05-01", "2026-05-07", WORK)), "1");
check("the marked saturday is counted", String(countWork("2026-05-08", "2026-05-11", WORK)), "2");
check("backwards is negative", String(countWork("2026-05-07", "2026-05-01", WORK)), "-1");
check("nowhere is zero", String(countWork("2026-05-01", "2026-05-01", WORK)), "0");

// The round trip, which is the property everything else leans on:
// `:end` measures a date into a duration and the scheduler advances that
// duration back into a date. If those two disagree by a day, a bar
// committed where it was previewed lands somewhere else.
//
// Both directions, and from a Saturday as well as a Friday, because the
// direction is the whole subtlety: a day off has two nearest working
// days, so a walk that snaps forward and then steps backwards is out by
// however wide the weekend was. The server had exactly that bug, and it
// was invisible from a working-day origin — which is the only kind this
// app happens to pass in today. A property is not a property of its
// current callers.
for (const from of ["2026-05-01", "2026-05-02", "2026-05-06", "2026-05-09"]) {
  const bad: string[] = [];
  for (let i = -20; i <= 40; i++) {
    const to = addDays("2026-05-01", i);
    const n = countWork(from, to, WORK);
    const there = advanceWork(from, n, WORK);
    // Zero is its own case, and it is the third answer rather than
    // either of the other two: nothing is walked, so the landing is
    // where `from` snapped to — forwards, because `advanceWork(d, 0)`
    // has to be the finish of a one-day task and a task starting on a
    // Saturday finishes on the Monday. Two days that snap back to the
    // same working day count zero and land there, not on `to`. The
    // server's `count`/`advance` pair does exactly this, and pretending
    // otherwise here would be a test asserting a contract nothing keeps.
    const want =
      n === 0
        ? snapForward(from, WORK)
        : n < 0
          ? snapBack(to, WORK)
          : snapForward(to, WORK);
    if (there !== want) bad.push(`${from}→${to}: ${there}≠${want} (n=${n})`);
  }
  check(`the inverse holds from ${from}, sixty days either side`, bad.join(" ") || "exact", "exact");
}

// And the upgrade promise: with the default calendar the two functions
// *are* `addDays` and `diffDays`, so every date the app computes is the
// one it computed before this existed.
{
  const bad: string[] = [];
  for (let i = -14; i <= 14; i++) {
    const to = addDays("2026-05-01", i);
    if (advanceWork("2026-05-01", i, DAYS) !== addDays("2026-05-01", i)) bad.push(`advance ${i}`);
    if (countWork("2026-05-01", to, DAYS) !== diffDays("2026-05-01", to)) bad.push(`count ${i}`);
    if (snapForward(to, DAYS) !== to) bad.push(`snap ${i}`);
  }
  check("days mode is the calendar arithmetic, unchanged", bad.join(" ") || "identical", "identical");
}

// ---- the two gestures whose preview must be the commit ----------------
//
// `Gantt` draws with these and `App` commits with them, so what is
// checked here is what both sides do. A drag is a count of columns —
// the axis stays calendar days — and these are where that stops being
// true.

function sched(start: string, end: string): Scheduled {
  return {
    id: "a",
    start,
    end,
    slack_days: 0,
    critical: false,
    blocked: false,
    overdue: false,
    late: false,
    level: 0,
    summary: false,
    progress: 0,
    children: 0,
  };
}

check(
  "a bar dropped on the saturday lands where the scheduler will put it",
  moveLanding(WORK, "2026-05-01", 1),
  "2026-05-07",
);
check(
  "a bar dropped on a working day lands there",
  moveLanding(WORK, "2026-05-11", 2),
  "2026-05-13",
);
check(
  "in days mode a drop is the day it was dropped on",
  moveLanding(DAYS, "2026-05-01", 1),
  "2026-05-02",
);
// Six columns pulled off the right edge of a one-day bar buys a single
// working day, because all six of them are golden week.
check(
  "a right edge dragged across golden week buys one day",
  String(resizeDuration(WORK, sched("2026-05-01", "2026-05-01"), 6)),
  "2",
);
check(
  "and a bar cannot be dragged shorter than the day it starts on",
  String(resizeDuration(WORK, sched("2026-05-11", "2026-05-15"), -20)),
  "1",
);
check(
  "in days mode the drag is the duration",
  String(resizeDuration(DAYS, sched("2026-05-01", "2026-05-03"), 2)),
  "5",
);

// ---- office mode still has a grid -------------------------------------

// Comments out, for `check-flash.ts`'s reason: this file's prose names
// the classes it is looking for, and a rule that had been deleted would
// still be "found" in the paragraph explaining it.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  " ",
);

check("the off-day band is drawn", String(css.includes(".gantt__off")), "true");
// The wash is 1.8% white, which over a white background is nothing. The
// override was added once for `.gantt__weekend` and has to survive the
// rename, or office mode loses the only vertical grid the chart has.
check(
  "and office mode overrides it, or the chart loses its grid",
  String(
    /:root\[data-theme="light"\]\s+\.gantt__off\s*\{[^}]*background:/.test(css),
  ),
  "true",
);
// The rename is finished, both ways round: a leftover rule would be dead
// CSS, and worse, would read as the band still being drawn.
check("nothing is still called a weekend", String(/\.gantt__weekend|\.datepick__day--weekend/.test(css)), "false");
check("the header cell and the picker follow the same name", String(css.includes(".gantt__day--off") && css.includes(".datepick__day--off")), "true");

console.log(`${ran - failures}/${ran} calendar checks passed`);
if (failures) process.exit(1);
