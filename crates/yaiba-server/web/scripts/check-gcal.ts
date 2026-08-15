/**
 * `:gcal push` is the only thing the `:` line may do to a calendar, and
 * it may only do it when it was asked for by name.
 *
 * Two rules, neither visible to `tsc`, and both about a route that leaves
 * the machine — this is the one command whose effect lands somewhere yaiba
 * does not own, on events it removes as well as adds:
 *
 * - **A bare `:gcal` is not a push.** `:proj` opens a picker on a bare
 *   word and that is fine, because a picker asks. There is nothing to ask
 *   here, so a bare verb that fell through to the route would write to a
 *   calendar other people may be looking at because somebody hit ⏎ early.
 * - **`login` is refused, not routed.** It cannot work from here at all:
 *   the consent screen needs a browser and a listener on this machine, and
 *   the credential it returns is the person's rather than the project's,
 *   so there is no endpoint to POST it to. Routed to the push it would
 *   write the calendar on the word `login`; fallen through to "not a
 *   command" it would read as the whole feature being missing.
 *
 * Run by `web-build`. The same shape as `check-join.ts`, for the same
 * reason: a command's routing is only otherwise checkable by typing it.
 */

import { COMMANDS, runCommand, type CommandContext } from "../src/commands.ts";
import type { AppData } from "../src/types.ts";

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

// No task in the world: nothing about `:gcal` reads one. Cast rather than
// built, because `AppData` carries the whole snapshot and the fields left
// out here are the ones a filled-in fixture would invite reading.
const data = {
  tasks: [],
  deps: [],
  schedule: { tasks: [], end: "2026-01-01" },
  today: "2026-01-01",
  as_of: false,
  node_id: "test",
} as unknown as AppData;

const ctx: CommandContext = {
  data,
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
  if (r.gcal?.push) parts.push("gcal.push");
  if (r.ops?.length) parts.push(`ops×${r.ops.length}`);
  if (r.ui) parts.push("ui");
  if (r.peer) parts.push("peer");
  if (r.project) parts.push("project");
  return parts.length ? parts.join(" | ") : "nothing";
}

// ---- the verb is required ---------------------------------------------

check("the push is reachable, spelled out", run("gcal push"), "gcal.push");

check("a bare :gcal writes nothing", run("gcal"), "error: usage: :gcal push");

// A near miss is the likelier typo than a bare verb, and it must not be
// generous: anything that is not `push` has not asked for a push.
check("an unknown verb writes nothing either", run("gcal pull"), "error: usage: :gcal push");

// ---- and it is the only thing the command does ------------------------

// The calendar is downstream of the plan. A push that also filed an op
// would put a task edit behind a command whose whole purpose is to change
// nothing here — and it would land on the undo stack, where a `u` cannot
// take back what Google already has.
check(
  "a push touches no task, no view and no project",
  String(runCommand("gcal push", ctx)?.ops?.length ?? 0),
  "0",
);

// ---- login is refused where it cannot work ----------------------------

check(
  "login is refused, naming what to run instead",
  run("gcal login"),
  "error: run `yaiba gcal login` in a terminal — it needs a browser, once per machine",
);

check(
  "login never reaches the push route",
  String(runCommand("gcal login", ctx)?.gcal?.push ?? "none"),
  "none",
);

// ---- completion offers what can be run, and nothing else --------------

// `login` is deliberately absent: completion is a list of things that
// work, and offering one that answers with a refusal is a worse menu than
// a short one. Typing it in full still finds the refusal above.
const spec = COMMANDS.find((c) => c.name === "gcal");
check(
  "gcal is in the completion table",
  String(Boolean(spec)),
  "true",
);
check(
  "and it offers exactly the verb that works",
  (spec?.args?.({ data, projects: ctx.projects }, 1) ?? []).join(","),
  "push",
);

console.log(`${ran - failures}/${ran} gcal checks passed`);
if (failures) process.exit(1);
