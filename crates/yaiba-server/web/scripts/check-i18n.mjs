/**
 * Every string that reaches `t()` has a Japanese line, and every line in
 * the catalogue is still reached.
 *
 * Neither half can be caught by the type checker: `t()` takes a string,
 * so a phrase added at a call site without a translation compiles and
 * silently ships in English, and one reworded in English leaves its old
 * Japanese behind as a line that will never be printed again. Both are
 * invisible until someone runs the UI in `ja` and reads every screen.
 *
 * Run by `web.yml` on every PR. Exits non-zero with the offending
 * strings listed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx?$/.test(path)) files.push(path);
  }
})(SRC);

/**
 * Comments out, so a `t("…")` written *about* the code is not mistaken
 * for one the code runs.
 *
 * Short of a TypeScript AST this is where the line is: prose is where an
 * example call plausibly appears — the module docs in `i18n.ts` open
 * with one — and a false positive there fails CI over a sentence. A
 * `t("…")` nested inside a string literal would still be counted, but
 * nothing here writes one, and the failure mode is a translation asked
 * for and never used rather than a missing one.
 *
 * Line comments are stripped after block ones so a `//` inside `/* … *\/`
 * cannot end the line early.
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

// `t("…")` at a call site. The optional newline covers the calls the
// formatter has broken across lines.
const CALL = /\bt\(\s*\n?\s*"((?:[^"\\]|\\.)*)"/g;
const used = new Set();
for (const file of files) {
  if (file.endsWith("i18n.ts")) continue;
  for (const m of code(readFileSync(file, "utf8")).matchAll(CALL)) used.add(m[1]);
}

// The strings that reach `t()` through a variable rather than a literal:
// the date columns' heads and hover text, and the refusal behind a
// summary's locked cells. Written in `dateColumns.ts` as data, so no
// call-site scan can see them.
const columns = readFileSync(join(SRC, "dateColumns.ts"), "utf8");
for (const m of columns.matchAll(/(?:head|title):\s*"([^"]*)"/g)) used.add(m[1]);
for (const m of columns.matchAll(/return "([^"]*)";/g)) used.add(m[1]);

// The catalogue's own keys: quoted, or bare where the key is an
// identifier (`crit:`, `due:`).
const catalogue = readFileSync(join(SRC, "i18n.ts"), "utf8");
const body = catalogue.slice(catalogue.indexOf("const JA"));
const defined = new Set();
const KEY = /^\s{2}(?:"((?:[^"\\]|\\.)*)"|([A-Za-z][A-Za-z0-9_]*)):/gm;
for (const m of body.matchAll(KEY)) defined.add(m[1] ?? m[2]);

const missing = [...used].filter((k) => !defined.has(k)).sort();
const unused = [...defined].filter((k) => !used.has(k)).sort();

if (missing.length || unused.length) {
  if (missing.length) {
    console.error(`${missing.length} string(s) with no Japanese in i18n.ts:`);
    for (const key of missing) console.error(`  + ${key}`);
  }
  if (unused.length) {
    console.error(`${unused.length} line(s) in i18n.ts nothing asks for:`);
    for (const key of unused) console.error(`  - ${key}`);
  }
  process.exit(1);
}

console.log(`i18n: ${used.size} strings, all translated, none stale`);
