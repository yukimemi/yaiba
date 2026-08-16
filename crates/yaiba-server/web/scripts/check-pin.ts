/**
 * A start pin is a floor, and a pin dropped inside a dependency's lag
 * adjusts the lag rather than being silently raised (#105).
 *
 * Same argument as `check-cells.ts`: this is a pure function of the
 * schedule, a wrong one type-checks perfectly, and `cargo make check`
 * is Rust-only — the scheduler that honours the lag lives in
 * `yaiba-core`, but the decision to *adjust* it is the web's. Run by
 * `web-build`, so it gates every PR through `web.yml`.
 *
 * The cases that matter are the boundaries: a pin exactly on the
 * predecessor's finish is the same-day case the field exists for, a pin
 * exactly at `pred_end + lag` adjusts nothing, and a pin before the
 * finish is the one refusal — it would invert the edge.
 */

import { earliestStart, pinStartOps } from "../src/commands.ts";
import {
  DEFAULT_CALENDAR,
  type AppData,
  type Scheduled,
  type Task,
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

// ---- fixtures -------------------------------------------------------

let nextId = 0;
function task(id: string, title: string, start: string | null): Task {
  nextId++;
  return {
    id,
    parent: null,
    title,
    notes: "",
    assignee: "",
    status: "todo",
    priority: 0,
    start,
    duration_days: 1,
    due: null,
    actual_start: null,
    actual_end: null,
    progress: 0,
    position: nextId,
    tags: [],
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    done_at: null,
  };
}

function sched(id: string, start: string, end: string): Scheduled {
  return {
    id,
    start,
    end,
    slack_days: 0,
    critical: true,
    blocked: false,
    overdue: false,
    late: false,
    level: 0,
    summary: false,
    progress: 0,
    children: 0,
  };
}

/**
 * A finishes 08-02; B waits for it. `lag` is the edge's spacing, so the
 * plain case is A two days wide and B placed the day after its finish.
 */
function fixture(lag: number): {
  data: AppData;
  a: Task;
  b: Task;
} {
  const a = task("a", "A", "2026-08-01");
  const b = task("b", "B", null);
  const data: AppData = {
    tasks: [a, b],
    deps: [{ from: "a", to: "b", lag_days: lag }],
    schedule: {
      tasks: [sched("a", "2026-08-01", "2026-08-02"), sched("b", "2026-08-03", "2026-08-03")],
      start: "2026-08-01",
      end: "2026-08-03",
      critical_path: ["a", "b"],
    },
    // Calendar days, which is what every date in here is written as.
    // The working-day reading of the same rule is `check-cal.ts`'s.
    calendar: DEFAULT_CALENDAR,
    today: "2026-08-01",
    as_of: false,
    node_id: "test",
  };
  return { data, a, b };
}

/** The ops, flattened to a comparable string. */
function plan(data: AppData, b: Task, date: string): string {
  const pin = pinStartOps(data, b, date);
  if (typeof pin === "string") return `refused: ${pin}`;
  const ops = pin.ops
    .map((op) =>
      op.kind === "patch"
        ? `patch start=${op.patch.start}`
        : `${op.kind} lag=${op.dep.lag_days}`,
    )
    .join(" ");
  return `${ops} | ${pin.note ?? "-"}`;
}

// ---- the floor -------------------------------------------------------

{
  const { data } = fixture(1);
  check(
    "no constraint without an edge",
    earliestStart([], data.schedule.tasks, "b") ?? "none",
    "none",
  );
  check(
    "the floor is the predecessor's finish",
    earliestStart(data.deps, data.schedule.tasks, "b") ?? "none",
    "2026-08-02",
  );
}

// ---- a pin inside the lag adjusts the lag ----------------------------

check(
  "the same-day case #81 asked for",
  plan(fixture(1).data, fixture(1).b, "2026-08-02"),
  "patch start=2026-08-02 addDep lag=0 | lag 1→0 on “A”",
);
check(
  "a pin exactly at pred_end + lag adjusts nothing",
  plan(fixture(1).data, fixture(1).b, "2026-08-03"),
  "patch start=2026-08-03 | -",
);
check(
  "a pin past the lag adjusts nothing either",
  plan(fixture(1).data, fixture(1).b, "2026-08-10"),
  "patch start=2026-08-10 | -",
);
check(
  "a longer lag shortens to the gap the pin implies",
  plan(fixture(5).data, fixture(5).b, "2026-08-04"),
  "patch start=2026-08-04 addDep lag=2 | lag 5→2 on “A”",
);
check(
  "a pin before the finish is refused, with the date to retry from",
  plan(fixture(1).data, fixture(1).b, "2026-08-01"),
  "refused: 2026-08-01 is before “A” finishes (2026-08-02)",
);

// Undo puts back the lag that was there — the default would read as an
// unrelated edit, the same rule `:dep` already keeps.
{
  const { data, b } = fixture(3);
  const pin = pinStartOps(data, b, "2026-08-02");
  const undo =
    typeof pin === "string"
      ? "refused"
      : pin.undoOps
          .map((op) =>
            op.kind === "patch"
              ? `patch start=${op.patch.start}`
              : `${op.kind} lag=${op.dep.lag_days}`,
          )
          .join(" ");
  check("undo restores the pin and the old lag", undo, "patch start=null addDep lag=3");
}

// ---- more than one predecessor ---------------------------------------

{
  const { data, b } = fixture(2);
  const c = task("c", "C", "2026-08-01");
  data.tasks.push(c);
  data.deps.push({ from: "c", to: "b", lag_days: 2 });
  data.schedule.tasks.push(sched("c", "2026-08-01", "2026-08-01"));
  // Both edges cross the pin: A ends 08-02 asking +2, C ends 08-01
  // asking +2, and 08-02 satisfies neither. Every crossed edge adjusts —
  // adjusting only the binding one would leave the other holding the
  // floor above the pin.
  check(
    "every crossed edge adjusts, not only the binding one",
    plan(data, b, "2026-08-02"),
    "patch start=2026-08-02 addDep lag=0 addDep lag=1 | lag adjusted on 2 links",
  );
  // The refusal names the predecessor whose finish is in the way.
  check(
    "a pin before either finish is refused",
    plan(data, b, "2026-08-01"),
    "refused: 2026-08-01 is before “A” finishes (2026-08-02)",
  );
}

// ---- no edge at all ---------------------------------------------------

{
  const data: AppData = { ...fixture(1).data, deps: [] };
  const b = data.tasks[1];
  check(
    "an unconstrained pin is the patch alone",
    plan(data, b, "2026-08-05"),
    "patch start=2026-08-05 | -",
  );
}

console.log(`${ran - failures}/${ran} pin checks passed`);
if (failures) process.exit(1);
