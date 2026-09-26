/**
 * A shared link must reproduce the view, and a hostile or stale one must
 * degrade instead of breaking.
 *
 * `urlState.ts` is pure, so this runs the real encoder and decoder: the
 * round trip, the field-by-field tolerance the fragment promises,
 * unicode and spaces in the filter, the origin being ignored, ticket
 * matching by room, ids the project does not have, and the length ceiling
 * dropping the fold list. Run by `web-build`.
 *
 * Executed with `bun`, like the other checks.
 */

import {
  MAX_FRAGMENT,
  decodeLink,
  encodeLink,
  parseTicket,
  projectNameFromTicket,
  pruneToIds,
  sameProject,
  type LinkState,
} from "../src/urlState.ts";

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

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const room = "ab".repeat(32);
const ticketA = `aaaa1111.${room}`;
const ticketB = `bbbb2222.${room.toUpperCase()}`;

const full: LinkState = {
  project: ticketA,
  view: "gantt",
  zoom: "week",
  columns: "dates",
  sort: "due",
  showHidden: true,
  filter: "open @alice #dev",
  fold: [id(1), id(2)],
  focus: id(3),
  asof: "2026-03-01",
  cursor: id(4),
};

// ---- round trip ----------------------------------------------------
{
  const { fragment, foldDropped } = encodeLink(full);
  check("round trip keeps every field", decodeLink("#" + fragment), { ...full, complete: true });
  check("round trip drops no folds", foldDropped, false);
  check("a full URL decodes the same", decodeLink(`http://127.0.0.1:7878/#${fragment}`), { ...full, complete: true });
  check("a full URL with a path and query too", decodeLink(`https://other.example/a/b?x=1#${fragment}`), { ...full, complete: true });
  check("text with no # is a fragment already", decodeLink(fragment), { ...full, complete: true });
  check("v is only a marker", fragment.startsWith("v=1&"), true);

  const min = encodeLink({ view: "list" });
  check("a sparse state stays sparse", min.fragment, "v=1&view=list");
  check("sparse round trip", decodeLink(min.fragment), { view: "list", complete: true });
  check("a hand-typed fragment is not complete", decodeLink("#view=list"), { view: "list" });

  const off = decodeLink(encodeLink({ showHidden: false }).fragment);
  check("hidden off round-trips as off, not absent", off, { showHidden: false, complete: true });
}

// ---- filters: unicode and spaces ------------------------------------
for (const q of [
  "open due:<2026-01-01",
  "タイトル 検索 ＠山田",
  "  leading and  double  spaces ",
  "a&b=c#d%e+f",
  "emoji 🗡️ ok",
  'quote"s \'and\' <angle>',
]) {
  const { fragment } = encodeLink({ filter: q });
  check(`filter survives: ${JSON.stringify(q)}`, decodeLink("#" + fragment)?.filter, q);
  check(`no raw space or + in: ${JSON.stringify(q)}`, /[ +]/.test(fragment), false);
}
check("an empty filter is not emitted", encodeLink({ filter: "" }).fragment, "v=1");

// ---- malformed input: dropped field by field ------------------------
check("nothing after # is null", decodeLink("#"), null);
check("empty string is null", decodeLink(""), null);
check("garbage is null", decodeLink("#!!!&&==&"), null);
check("a URL with no fragment is null", decodeLink("http://127.0.0.1:7878/"), null);
check(
  "a bad enum drops that field only",
  decodeLink("#view=nope&zoom=week&sort=nope&cols=dates"),
  { zoom: "week", columns: "dates" },
);
check("a bad escape drops that field only", decodeLink("#q=%E0%A4%A&view=list"), { view: "list" });
check("a bad date is dropped", decodeLink("#asof=2026-02-30&view=list"), { view: "list" });
check("a wrong-shape date is dropped", decodeLink("#asof=tomorrow&view=list"), { view: "list" });
check("hid needs a real 0 or 1", decodeLink("#hid=yes&view=list"), { view: "list" });
check("unknown keys are ignored", decodeLink("#zzz=1&view=list&theme=neon"), { view: "list" });
check("the first of a repeated key wins", decodeLink("#view=list&view=gantt"), { view: "list" });
check("duplicate fold ids collapse", decodeLink("#fold=a,b,a,,b")?.fold, ["a", "b"]);
check("a key with no value is skipped", decodeLink("#view&zoom=week"), { zoom: "week" });
check("theme and colours never come out", /theme|color|lang|pane/.test(encodeLink(full).fragment), false);

// ---- tickets --------------------------------------------------------
check("a ticket parses", parseTicket(ticketA), { endpoint: "aaaa1111", room });
check("a ticket without a room does not", parseTicket("aaaa1111"), null);
check("a non-hex room does not", parseTicket("aaaa.zz"), null);
check("junk does not", parseTicket("<script>.1"), null);
check("same room is the same project across endpoints and case", sameProject(ticketA, ticketB), true);
check("a different room is a different project", sameProject(ticketA, `aaaa1111.${"cd".repeat(32)}`), false);
check("an unparseable ticket never matches", sameProject(ticketA, "nope"), false);
check("the ticket travels verbatim", decodeLink("#p=" + encodeURIComponent(ticketA))?.project, ticketA);

check("the join name mirrors name_from_ticket", projectNameFromTicket(ticketA), "peer-aaaa1111");
check("and lowercases and caps at 8", projectNameFromTicket("ABCDEFGHIJKL.ff"), "peer-abcdefgh");
check("and has a fallback", projectNameFromTicket("---.ff"), "peer");

// ---- ids the project does not have ----------------------------------
{
  const all = new Set([id(1), id(3), id(4)]);
  const { state, complete } = pruneToIds(full, all);
  check("unknown fold ids are removed", state.fold, [id(1)]);
  check("known focus and cursor stay", [state.focus, state.cursor], [id(3), id(4)]);
  check("some ids missing: not complete", complete, false);
  check("the rest of the state is untouched", { ...state, fold: full.fold }, {
    ...full,
    fold: full.fold,
  });

  const gone = pruneToIds(full, []);
  check("nothing known: fold, focus and cursor all go", [gone.state.fold, gone.state.focus, gone.state.cursor], [undefined, undefined, undefined]);
  check("nothing known: view fields survive", gone.state.sort, "due");

  const ok = pruneToIds(full, [id(1), id(2), id(3), id(4)]);
  check("all present: complete", ok.complete, true);
  check("all present: unchanged", ok.state, full);
  check("a link with no ids is trivially complete", pruneToIds({ view: "list" }, []).complete, true);
}

// ---- the ceiling ----------------------------------------------------
{
  const many = Array.from({ length: 200 }, (_, i) => id(i));
  const big = encodeLink({ ...full, fold: many });
  check("over the ceiling the fold list is dropped", big.foldDropped, true);
  check("the dropped link is within the ceiling", big.fragment.length <= MAX_FRAGMENT, true);
  const back = decodeLink(big.fragment);
  check("the dropped link keeps everything else", { ...back }, { ...full, fold: undefined, complete: true });

  const few = Array.from({ length: 20 }, (_, i) => id(i));
  const small = encodeLink({ ...full, fold: few });
  check("under the ceiling nothing is dropped", small.foldDropped, false);
  check("under the ceiling the folds are all there", decodeLink(small.fragment)?.fold, few);

  const tiny = encodeLink({ ...full, fold: [id(1)] }, 10);
  check("a link that cannot fit even without folds still comes out", tiny.foldDropped, true);
  check("and is not truncated mid-escape", decodeLink(tiny.fragment)?.filter, full.filter);
}

console.log(`\n${ran - failures}/${ran} checks passed`);
if (failures > 0) process.exit(1);
