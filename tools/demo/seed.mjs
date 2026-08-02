/**
 * The plan the demo opens on.
 *
 * Seeded over the HTTP API rather than by shipping a `.db`, because a
 * database file would freeze both the schema and the dates: every task
 * here is placed relative to the day the recording runs, so the gif
 * always shows a plan in flight rather than one that expired the week
 * it was made.
 *
 * Eleven rows, and that is a ceiling rather than a taste: the frame is
 * 472px tall, which is twelve rows, and the storyboard adds the twelfth
 * with `o`. A thirteenth scrolls the list mid-take and the eye loses the
 * row it was following.
 *
 * One row deliberately has no predecessor. A plan that is one chain end
 * to end is *entirely* critical, and a gantt where every bar is magenta
 * says nothing — the colour only carries "this is what the date hangs
 * on" when something else is drawn in the other one.
 */

/**
 * `n` days from today, as the ISO date the API takes.
 *
 * Built from the local parts rather than `toISOString().slice(0, 10)`,
 * which converts to UTC first and so names the wrong day for part of
 * every day outside UTC — nine hours of it in JST, where this was
 * written. Every offset below is relative to the reference date the
 * *server* computes locally, so a seed that disagrees with it by a day
 * puts `due: day(-1)` on today and the overdue row quietly stops being
 * overdue.
 */
function day(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The seed, in the order rows appear. `parent` names an earlier title;
 * `after` is implicit, since the API appends.
 */
const ROWS = [
  { title: "Board rev C" },

  { title: "Design", parent: "Board rev C" },
  {
    title: "Schematic",
    parent: "Design",
    assignee: "yuki",
    status: "done",
    // Only five days of history. The window has to hold it *and* the
    // work ahead, and at day zoom the pane is about eighteen days wide —
    // a longer past is a past that is scrolled off in the opening frame.
    start: day(-5),
    duration_days: 2,
    actual_start: day(-5),
    actual_end: day(-3),
    tags: ["hw"],
  },
  {
    title: "Layout",
    parent: "Design",
    assignee: "mika",
    status: "doing",
    start: day(-3),
    duration_days: 4,
    progress: 60,
    // Yesterday, so the row is overdue on every take — the amber the
    // list and the bar both pick up is #95, and it needs a real
    // overdue task to show at all.
    due: day(-1),
    actual_start: day(-3),
    tags: ["hw"],
  },

  { title: "Fabrication", parent: "Board rev C" },
  {
    title: "Order boards",
    parent: "Fabrication",
    assignee: "yuki",
    duration_days: 2,
    // A note is the only way the marker (#96) appears, and the marker
    // is the point — not the text, which nothing in the gif opens.
    notes: "Two-week lead time from the usual house; ask for the rev B panel.",
  },
  {
    title: "Assembly",
    parent: "Fabrication",
    assignee: "rin",
    duration_days: 3,
  },

  { title: "Bring-up", parent: "Board rev C" },
  {
    title: "Power rails",
    parent: "Bring-up",
    assignee: "mika",
    duration_days: 2,
  },
  {
    // The row with no predecessor. It carries slack, so it is drawn in
    // the non-critical colour — which is what makes the magenta
    // everywhere else mean something.
    title: "Test plan",
    parent: "Bring-up",
    assignee: "yuki",
    duration_days: 3,
  },
  {
    title: "Smoke test",
    parent: "Bring-up",
    duration_days: 4,
  },
];

/**
 * Edges, by title. The lags are the ones worth seeing: `+5` is a real
 * wait (a board house), `+0` is two jobs in one sitting — the shape
 * that `03cedcc` added the field for.
 */
const EDGES = [
  { from: "Layout", to: "Order boards", lag_days: 5 },
  { from: "Order boards", to: "Assembly", lag_days: 1 },
  { from: "Assembly", to: "Power rails", lag_days: 0 },
  { from: "Power rails", to: "Smoke test", lag_days: 1 },
];

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Fill an empty database. Returns a title → id map, which the
 * storyboard uses to point the mouse at a row without counting pixels.
 */
export async function seed(base) {
  const ids = new Map();

  for (const row of ROWS) {
    const { parent, ...rest } = row;
    const state = await post(base, "/api/tasks", {
      ...rest,
      parent: parent ? ids.get(parent) : null,
    });
    // The API answers with the whole state rather than the new row, so
    // the id comes back by title. Titles are unique here by
    // construction — a duplicate would silently link the wrong edge.
    const made = state.tasks.filter((t) => t.title === row.title);
    if (made.length !== 1) {
      throw new Error(`seed: ${made.length} rows titled ${row.title}`);
    }
    ids.set(row.title, made[0].id);
  }

  for (const edge of EDGES) {
    await post(base, "/api/deps", {
      from: ids.get(edge.from),
      to: ids.get(edge.to),
      lag_days: edge.lag_days,
    });
  }

  return ids;
}
