/**
 * `:join` and `:merge` are opposites, and neither may drift onto the
 * other's route.
 *
 * They were one word until v0.21 — `:join` was the *merge*, which mixes
 * two task sets together in both replicas and cannot be undone, while
 * the CLI's `join` subcommand did the safe thing. That cost somebody a
 * separation they had deliberately set up.
 *
 * Nothing else can catch a swap. `runCommand` returns a plain object, so
 * routing `:join` to `peer.merge` type-checks perfectly; `cargo make
 * check` is Rust-only; and by the time the difference is visible on
 * screen the merge has already happened, on both sides, for good. Run by
 * `web-build`, so it gates every PR through `web.yml`.
 */

import { runCommand, type CommandContext } from "../src/commands.ts";
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
  if (r.peer?.merge) parts.push(`peer.merge=${r.peer.merge}`);
  if (r.peer?.showTicket) parts.push("peer.showTicket");
  if (r.project?.join) parts.push(`project.join=${r.project.join}`);
  if (r.project?.create) parts.push(`project.create=${r.project.create}`);
  if (r.project?.switch) parts.push(`project.switch=${r.project.switch}`);
  if (r.project?.pick) parts.push("project.pick");
  return parts.length ? parts.join(" | ") : "nothing";
}

const TICKET = "abc.def";

// ---- the split itself -------------------------------------------------

check(
  ":join opens a project of its own",
  run(`:join ${TICKET}`.slice(1)),
  `project.join=${TICKET}`,
);

check(
  ":merge is the destructive one, and the only one that reaches a peer",
  run(`merge ${TICKET}`),
  `peer.merge=${TICKET}`,
);

// The pair above is the assertion; these two say it from the other side,
// so a swap fails twice rather than passing half the file.

check(
  ":join never reaches the merge route",
  String(runCommand(`join ${TICKET}`, ctx)?.peer?.merge ?? "none"),
  "none",
);

check(
  ":merge never creates a project",
  String(runCommand(`merge ${TICKET}`, ctx)?.project?.join ?? "none"),
  "none",
);

// ---- neither guesses at a missing ticket ------------------------------

// A bare `:join` that fell through to its route would create a project
// named after nothing, and a bare `:merge` would parse an empty ticket.

check("a bare :join is a usage error", run("join"), "error: usage: :join <ticket>");
check("a bare :merge is a usage error", run("merge"), "error: usage: :merge <ticket>");

// ---- the old spelling is gone, not repurposed -------------------------

// `:merge` has to be its own command rather than an alias of `:join`,
// which is what an `aliases:` entry would have made it.

check(
  "the two are separate commands, not aliases",
  String(runCommand("join x.y", ctx)?.project?.join === "x.y" &&
    runCommand("merge x.y", ctx)?.peer?.merge === "x.y"),
  "true",
);

console.log(`${ran - failures}/${ran} join/merge checks passed`);
if (failures) process.exit(1);
