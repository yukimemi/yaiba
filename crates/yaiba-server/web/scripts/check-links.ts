/**
 * `gx` opens what a row's notes link to, and never asks a question with
 * one answer.
 *
 * The picker's decisions live in `notes.ts` as pure functions — how many
 * distinct links a note has decides between "say nothing", "open it" and
 * "ask which" — so they are checked here rather than through a browser.
 * Run by `web-build`, so it gates every PR through `web.yml`.
 */

import { linksToOpen, stepCursor } from "../src/notes.ts";

let ran = 0;
let failures = 0;

function check(label: string, got: unknown, want: unknown): void {
  ran++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures++;
  console.error(`FAIL  ${label}\n        got  ${g}\n        want ${w}`);
}

check("no links", linksToOpen("just a note"), []);
check("empty note", linksToOpen(""), []);
check("one link", linksToOpen("see https://a.test/x"), ["https://a.test/x"]);
check(
  "trailing punctuation comes off",
  linksToOpen("(https://a.test/x), ok"),
  ["https://a.test/x"],
);
check(
  "several links keep their order",
  linksToOpen("https://a.test https://b.test\nhttp://c.test"),
  ["https://a.test", "https://b.test", "http://c.test"],
);
check(
  "a repeated link is one destination",
  linksToOpen("https://a.test and again https://a.test"),
  ["https://a.test"],
);

check("step forward", stepCursor(0, 1, 3), 1);
check("wrap past the end", stepCursor(2, 1, 3), 0);
check("wrap before the start", stepCursor(0, -1, 3), 2);
check("empty list stays put", stepCursor(0, 1, 0), 0);

if (failures) {
  console.error(`\nlinks: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`links: ${ran} checks, all passing`);
