/**
 * Re-records `assets/demo.gif`.
 *
 * `cargo make demo-gif` is the way in. The whole take is scripted here —
 * the server, the plan it opens on, every keystroke and the encode — so
 * that a gif made a year from now differs from this one only where the
 * app does, which is the only reason the old one could not be updated:
 * it was recorded by hand and nothing said how.
 *
 * The pieces:
 *   - a `yaiba` release binary, started on a scratch data dir so the run
 *     never touches the project registry you actually use;
 *   - `seed.mjs`, which fills it over the API;
 *   - Chromium under playwright at exactly the frame size the README
 *     wants, with a lossless screencast running the whole time;
 *   - `storyboard` below, which is the take;
 *   - ffmpeg, two-pass, for a palette that survives a UI that changes
 *     theme halfway through.
 *
 * Flags: `--shots` writes a PNG per beat instead of a gif, which is how
 * you check a change to the storyboard without waiting on an encode —
 * `cargo make demo-shots` is that. `--headed` shows the browser;
 * `--keep` leaves the frames and the scratch database behind.
 *
 * Run it with `node`. Under `bun` the browser launches and nothing ever
 * connects to it — see AGENTS.md, "Re-recording the README's demo gif".
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { seed } from "./seed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

/** The README's `<img width="900">`. Height follows the old gif. */
const WIDTH = 900;
const HEIGHT = 472;

/** 128 colours, as the first demo.gif was encoded at. */
const COLORS = 128;

/** Loopback, and not 8188: a yaiba you are already using keeps its port. */
const PORT = 8288;
const BASE = `http://127.0.0.1:${PORT}`;

const argv = new Set(process.argv.slice(2));
const SHOTS = argv.has("--shots");
const HEADED = argv.has("--headed");
const KEEP = argv.has("--keep");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  console.log(`[demo] ${msg}`);
}

// ---------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------

function binary() {
  const exe = process.platform === "win32" ? "yaiba.exe" : "yaiba";
  const path = join(ROOT, "target", "release", exe);
  if (!existsSync(path)) {
    throw new Error(
      `no release binary at ${path} — run \`cargo make release-build\` first ` +
        `(\`cargo make demo-gif\` does it for you)`,
    );
  }
  return path;
}

/**
 * Whether anything at all is already listening on the recorder's port.
 *
 * Asked *before* the spawn, and the reason is not tidiness. If the port
 * is taken, the child fails to bind and exits — but `exitCode` is still
 * null on the first pass of the readiness loop below, so the very next
 * `fetch` succeeds against the *other* process. The recorder would then
 * seed eleven tasks into somebody's real database and drive a storyboard
 * through it, and everything would look like it worked.
 *
 * A TCP connect rather than a `GET /api/state`, because the squatter
 * does not have to be a yaiba for the bind to fail.
 */
function portIsTaken() {
  return new Promise((answer) => {
    const socket = connect({ port: PORT, host: "127.0.0.1" });
    const settle = (taken) => {
      socket.destroy();
      answer(taken);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

async function startServer(dataDir) {
  if (await portIsTaken()) {
    throw new Error(
      `something is already listening on ${BASE} — stop it and re-run.\n` +
        `The recorder cannot tell its own server from another one once it ` +
        `is answering, and it seeds and edits whatever replies.`,
    );
  }

  // `new board` rather than the default project, because the name is on
  // screen for the whole take and the chip is about six characters wide.
  const args = ["new", "board", "--port", String(PORT), "--no-open", "--no-sync"];
  const child = spawn(binary(), args, {
    // `--no-sync` because a demo has no peer to reach, and binding the
    // UDP socket for one costs a Windows firewall prompt on a machine
    // that may not be able to grant it. `YAIBA_DATA_DIR` moves the whole
    // root, registry included, so the scratch project is never adopted
    // into the list the picker shows you.
    env: {
      ...process.env,
      YAIBA_DATA_DIR: dataDir,
      YAIBA_NO_AUTOUPDATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = [];
  child.stdout.on("data", (d) => output.push(d.toString()));
  child.stderr.on("data", (d) => output.push(d.toString()));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(output.join(""));
    }
  });

  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) {
      throw new Error(`yaiba exited early:\n${output.join("")}`);
    }
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) {
        // Second lock on the same hazard: a fresh `YAIBA_DATA_DIR` has no
        // tasks in it, so anything with rows in it is not the database
        // this process just made — and the seed is about to write to it.
        const state = await res.json();
        if (state.tasks?.length) {
          throw new Error(
            `the server on ${BASE} already holds ${state.tasks.length} tasks, ` +
              `so it is not the scratch one this run started. Refusing to seed it.`,
          );
        }
        log(`server up on ${BASE}`);
        return child;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Refusing to seed")) throw err;
      // Not listening yet — sqlite open and the iroh-less startup take
      // a moment on a cold disk.
    }
    await wait(100);
  }
  throw new Error(`yaiba never answered on ${BASE}:\n${output.join("")}`);
}

/**
 * Kill it, and mean it. A plain `child.kill()` on Windows leaves the
 * process holding its database file, and the scratch directory then
 * refuses to be removed — the same trap `AGENTS.md` records for
 * worktrees.
 */
async function stopServer(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((done) => {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      }).on("exit", done);
    });
  } else {
    child.kill("SIGTERM");
  }
  // Give the handle time to close before anything tries to delete the db.
  for (let i = 0; i < 50 && child.exitCode === null; i++) await wait(100);
}

// ---------------------------------------------------------------------
// The take
// ---------------------------------------------------------------------

/**
 * Beats are named so `--shots` writes files you can read in order, and
 * so a timing change reads as a timing change in the diff.
 *
 * `k` presses a key and then holds, because a gif is watched rather than
 * stepped through: every hold below is somebody's reading time, not a
 * wait on the app. The app is faster than all of them.
 */
async function storyboard(page, beat, mouse) {
  const k = async (key, hold = 240) => {
    await page.keyboard.press(key);
    await wait(hold);
  };
  // A chord — `gd`, `zM`, `co` — is one command, so `gap` is 0 and only
  // the whole thing is held. A repeat — `lll` — wants the gap, because
  // three steps that land at once read as one jump.
  const keys = async (str, hold = 240, gap = 0) => {
    for (const ch of str) {
      await page.keyboard.press(ch);
      if (gap) await wait(gap);
    }
    await wait(hold);
  };
  const type = async (text, hold = 300) => {
    await page.keyboard.type(text, { delay: 55 });
    await wait(hold);
  };
  const cmd = async (line, hold = 900) => {
    await page.keyboard.press(":");
    await wait(200);
    await page.keyboard.type(line, { delay: 60 });
    await wait(350);
    await page.keyboard.press("Enter");
    await wait(hold);
  };

  // A plan already in flight: a done row with its actual rail, an
  // overdue one, a note, five edges and a critical path with something
  // else beside it. Opening on an empty list would spend the first
  // seconds proving the app can hold data.
  await beat("00-plan", 1200);

  // Walking down is also how the timeline scrolls — the pane follows the
  // cursor, so three `j` bring the history, and the rail under the row
  // that is running late, into the frame.
  await keys("jjj", 1300, 300);
  await beat("01-walk");

  // ---- the keyboard builds a row
  await k("G", 500);
  await k("o", 450);
  await type("Ship to QA", 350);
  // `esc`, not `⏎`: Enter commits *and opens the next row*, which is
  // right when you are entering a list and wrong here — the take has one
  // row to add and everything after it is a normal-mode key.
  await k("Escape", 800);
  await beat("02-open");

  await keys("+++", 800, 280);
  await beat("03-lengthen");

  // `D`, then walk to what it waits for.
  await k("D", 700);
  await k("k", 400);
  await k("Enter", 1000);
  // The pane follows the *cursor*, and the cursor has not moved — so the
  // bar that just jumped a fortnight out is off the right edge until
  // something asks the pane to look again. `k` onto the predecessor and
  // `j` back is that ask, and it is also how you check what an edge did.
  await k("k", 700);
  await k("j", 1100);
  await beat("04-depend");

  // ---- room for the columns, then the columns
  //
  // The drag comes first because the list is under half the width here
  // and six columns do not fit in it: `gd` on a narrow pane spends the
  // title column to draw the dates, and a roster with no names in it is
  // not what the columns are for.
  await mouse.dragDivider();
  // The grip keeps the keyboard after a drag — by design, since `tab` is
  // the layout cycle and there is no other way to key your way onto it.
  // So `h` / `l` move the divider until something else takes focus, and
  // every cell motion below would go to the wrong place. Clicking a row
  // is how a hand actually takes it back, and it is a documented gesture
  // in its own right: click a row, put the cursor on it.
  //
  // The row it takes it back *on* is the one everything below is about:
  // the one in flight, which is the only row with a plan worth comparing
  // against a record.
  await mouse.clickRow("Layout");
  await beat("05-split");

  await keys("gd", 1300);
  await beat("06-columns");

  // Three steps in from the title: `owner`, `start`, `end`. `⏎` edits
  // the cell the cursor stands in, which on a date column is the
  // calendar `ce` opens — reached by walking rather than by naming the
  // field.
  await keys("lll", 900, 320);
  await beat("07-cells");

  // Two days later on the `end` of the row that is already running late.
  // Picking an end writes a *duration*, and the four tasks downstream of
  // it move — which is the answer the forward pass exists to give, and
  // the reason the critical path stays magenta rather than going slack.
  await k("Enter", 800);
  await keys("ll", 500, 280);
  await k("Enter", 1500);
  await beat("08-calendar");

  // ---- the plan, onto the record
  //
  // Back one cell to `start`, then two cells wide and one row tall.
  await k("h", 500);
  await k("v", 500);
  await k("l", 500);
  await k("y", 900);
  await beat("09-yank");
  // `y` leaves the cursor where the visual cursor was — the right-hand
  // cell, `end` — so one `l` is already `began`. Two would run the block
  // off the last column, which the status line says and the paste
  // refuses rather than half-writing.
  await k("l", 500);
  await k("p", 1500);
  await beat("10-put");

  // ---- who owns it
  //
  // `↓` before `⏎` on purpose: with nothing highlighted, Enter commits
  // what was *typed*, and the row would end up owned by "r". Walking
  // onto the candidate is also the only thing keeping one person from
  // becoming two spellings, which is the whole reason the panel lists
  // the names already in use instead of offering a bare box.
  await keys("co", 800);
  await type("r", 600);
  await k("ArrowDown", 700);
  await k("Enter", 1400);
  await beat("11-owner");

  // ---- the altitude
  //
  // `zm`, not `zM`. All the way shut is one row here — this plan is one
  // project, and "every project on one screen" needs more than one to be
  // a picture. One level shallower is the phases, each drawing its
  // children's span and their duration-weighted roll-up, which is the
  // thing worth seeing. `zR` opens it back up, because everything after
  // this is a whole-list shot and four rows leave two thirds of the
  // frame empty.
  await keys("zm", 1600);
  await beat("12-fold");
  await keys("zR", 1300);
  await beat("13-unfold");

  // ---- the modes
  await keys("gt", 1600);
  await beat("14-office");

  await cmd("lang ja", 1700);
  await beat("15-japanese");
}

/**
 * A pointer you can see.
 *
 * Neither a screencast nor playwright's video carries the cursor — the
 * compositor draws the page, and the pointer is the OS's. On a keyboard
 * demo that costs nothing; on the two beats that are *about* the mouse
 * it is the whole gesture, and a divider that slides with nothing
 * touching it reads as an animation rather than a drag.
 *
 * So the page gets one drawn into it, outside `#root` where React will
 * not tidy it away, and it is shown only while the mouse is doing
 * something. An arrow parked in the corner through a keyboard sequence
 * is just something else for the eye to check.
 */
async function installPointer(page) {
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.id = "demo-pointer";
    el.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "width:22px",
      "height:22px",
      "z-index:99999",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity 160ms linear",
      // A white arrow with a dark keyline, so it stays legible on the
      // neon theme and on the light one without changing.
      "background:no-repeat center/contain url(\"data:image/svg+xml;utf8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
            '<path d="M4 2 L4 18 L8.5 14 L11 20.5 L14 19.2 L11.5 13 L17.5 13 Z" ' +
            'fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>',
        ) +
        "\")",
    ].join(";");
    document.body.appendChild(el);
  });

  const set = (css) => page.evaluate((c) => {
    const el = document.getElementById("demo-pointer");
    if (el) Object.assign(el.style, c);
  }, css);

  return {
    async to(x, y) {
      await page.mouse.move(x, y);
      // The arrow's tip is its top-left corner, which is where the hit
      // point is — no centring offset.
      await set({ transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)` });
    },
    show: () => set({ opacity: "1" }),
    hide: () => set({ opacity: "0" }),
    // Pressed is a size change rather than a second graphic: it survives
    // the palette quantisation, where a faint ring would not. The `scale`
    // property, not a `transform`, because `transform` is holding the
    // position and writing both from two places is how one of them ends
    // up clobbered.
    down: () => set({ scale: "0.8" }),
    up: () => set({ scale: "1" }),
  };
}

/**
 * The one gesture with no key: the divider between list and timeline.
 *
 * The line you see is the thing you grab, so the grip's own box is where
 * to aim — no guessing at a hit area, and no scaling arithmetic, because
 * playwright's mouse is in CSS pixels and `boundingBox` answers in the
 * same ones.
 */
async function dragDivider(page, pointer, by = 210) {
  const grip = page.locator('[role="separator"]').first();
  const box = await grip.boundingBox();
  if (!box) throw new Error("no split grip to drag — did the markup change?");

  const y = box.y + box.height / 2;
  const from = box.x + box.width / 2;

  // Come in from the side, so the arrow is seen arriving at the grip
  // rather than appearing on top of it.
  await pointer.to(from - 90, y + 40);
  await pointer.show();
  await wait(400);
  await pointer.to(from, y);
  await wait(500);

  await page.mouse.down();
  await pointer.down();
  await wait(300);
  // In steps, because the grip is dragged rather than teleported, and a
  // gif shows the difference.
  for (let i = 1; i <= 5; i++) {
    await pointer.to(from + (by * i) / 5, y);
    await wait(120);
  }
  await page.mouse.up();
  await pointer.up();
  await wait(800);
}

/** Click a row — the mouse's way to put the cursor on one. */
async function clickRow(page, pointer, title) {
  const box = await page.getByText(title).first().boundingBox();
  if (!box) throw new Error(`no row titled ${title} to click`);

  await pointer.to(box.x + box.width / 2, box.y + box.height / 2);
  await wait(500);
  await page.mouse.down();
  await pointer.down();
  await wait(140);
  await page.mouse.up();
  await pointer.up();
  await wait(500);
  await pointer.hide();
  await wait(300);
}

// ---------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------

/**
 * Chromium, or an error that says how to get one.
 *
 * `playwright-core` is the package that deliberately downloads no
 * browser — which is why it is the dependency here, and why the browser
 * is a separate install step that `cargo make demo-deps` runs. Someone
 * who reaches for `node record.mjs` directly skips that step, and what
 * playwright says then is about an executable path: true, and a long way
 * from the one command that fixes it.
 */
async function launchBrowser() {
  try {
    return await chromium.launch({
      headless: !HEADED,
      // The full browser rather than the headless shell: the UI leans on
      // blend modes and filters for the neon theme, and the shell is not
      // what a reader will see it in.
      channel: "chromium",
    });
  } catch (err) {
    if (!/Executable doesn't exist|playwright install/i.test(String(err?.message))) throw err;
    throw new Error(
      "chromium is not installed for playwright. Run:\n" +
        "  node node_modules/playwright-core/cli.js install chromium\n" +
        "from tools/demo — or just use `cargo make demo-gif`, which does it.\n\n" +
        `Original error: ${err.message}`,
    );
  }
}

// ---------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------

/**
 * Lossless frames, straight off the compositor.
 *
 * Playwright's own `recordVideo` was the obvious way in and is the wrong
 * one: it writes VP8, and VP8 is lossy in the way that matters most
 * here. A second of a *motionless* screen comes back as twelve frames
 * that differ from each other by a pixel or two everywhere, which a gif
 * cannot collapse — it has no concept of "nearly the same", only of
 * "identical, so leave it transparent". The first take of this demo came
 * out at 6.2MB, and about five of those were compression noise sitting
 * on a screen where nothing was happening.
 *
 * `Page.startScreencast` with `format: png` hands over the real pixels,
 * so a still second is a still second and costs almost nothing. It also
 * only emits when the page actually paints, which is why the frames
 * carry their own timestamps below rather than a frame number.
 */
async function startScreencast(page) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];

  cdp.on("Page.screencastFrame", (event) => {
    frames.push({
      // Seconds since the epoch, from the compositor. Preferred over the
      // arrival time here, which carries the transport's jitter.
      at: event.metadata?.timestamp ?? Date.now() / 1000,
      png: Buffer.from(event.data, "base64"),
    });
    // Unacknowledged frames stop the stream, and a detached session
    // rejects the ack — which is not an error, it is the end.
    cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });

  await cdp.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
    maxWidth: WIDTH,
    maxHeight: HEIGHT,
  });

  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
    return frames;
  };
}

/**
 * Write the frames out with the timing they were captured at.
 *
 * ffmpeg's concat demuxer takes a duration per file, which is how a
 * variable-rate capture becomes something with a clock again. The last
 * frame is named twice on purpose: the demuxer applies a `duration` to
 * the *following* entry, so without the repeat the final frame would
 * flash past and the gif would loop out of a half-drawn beat.
 */
async function writeFrames(frames, dir, tailSeconds) {
  if (frames.length < 2) {
    throw new Error(`screencast produced ${frames.length} frames — nothing to encode`);
  }
  await mkdir(dir, { recursive: true });

  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const name = `f${String(i).padStart(5, "0")}.png`;
    await writeFile(join(dir, name), frames[i].png);
    const next = frames[i + 1];
    const seconds = next ? next.at - frames[i].at : tailSeconds;
    lines.push(`file '${name}'`, `duration ${Math.max(seconds, 1 / 60).toFixed(4)}`);
  }
  lines.push(`file 'f${String(frames.length - 1).padStart(5, "0")}.png'`);

  const list = join(dir, "frames.txt");
  await writeFile(list, lines.join("\n"));
  return list;
}

// ---------------------------------------------------------------------
// The encode
// ---------------------------------------------------------------------

function ffmpeg(args) {
  return new Promise((done, fail) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const err = [];
    p.stderr.on("data", (d) => err.push(d.toString()));
    p.on("error", () =>
      fail(new Error("ffmpeg not found on PATH — install it and re-run")),
    );
    p.on("exit", (code) =>
      code === 0 ? done() : fail(new Error(`ffmpeg failed:\n${err.join("")}`)),
    );
  });
}

/**
 * Two passes, because one global palette on a UI that flips from a dark
 * neon theme to a light one bands both. `stats_mode=diff` weights the
 * palette towards what actually moves between frames, which on a gantt
 * is the bars rather than the background.
 *
 * `dither=none` because the source is a screen, not a photograph: every
 * colour on it is already flat, so dithering has nothing to smooth and
 * only sprays noise across regions the gif would otherwise store as one
 * run. `diff_mode=rectangle` then confines each frame to the box that
 * actually changed.
 */
async function encode(list, gif) {
  const palette = join(dirname(list), "palette.png");
  // No `fps` filter, and that is the second half of the size story. The
  // screencast emits one frame per paint, and this UI paints on state
  // changes rather than on a clock — a whole storyboard is under a
  // hundred distinct pictures. Resampling that to a constant rate writes
  // hundreds more frames that are all duplicates of one of them. A gif
  // carries a delay per frame, so the capture's own timing is what
  // ships, and `-fps_mode passthrough` is what stops ffmpeg helpfully
  // regularising it on the way out.
  const chain = `scale=${WIDTH}:-1:flags=lanczos`;
  const input = ["-f", "concat", "-safe", "0", "-i", list];

  await ffmpeg([
    "-y", ...input,
    "-vf", `${chain},palettegen=max_colors=${COLORS}:stats_mode=diff`,
    palette,
  ]);
  await ffmpeg([
    "-y", ...input, "-i", palette,
    "-lavfi", `${chain}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`,
    "-fps_mode", "passthrough",
    "-loop", "0",
    gif,
  ]);
}

// ---------------------------------------------------------------------

async function main() {
  const work = await mkdtemp(join(tmpdir(), "yaiba-demo-"));
  const dataDir = join(work, "data");
  await mkdir(dataDir, { recursive: true });

  let server;
  let browser;
  try {
    server = await startServer(dataDir);
    const seeded = await seed(BASE);
    // The last row to be written is the last one to render, so it is
    // what "the plan is on screen" means. Taken from the seed rather
    // than spelled out again, so renaming a task there cannot leave a
    // 30-second timeout here.
    const lastRow = [...seeded.keys()].at(-1);
    log("plan seeded");

    browser = await launchBrowser();

    const shotDir = join(ROOT, "target", "demo-shots");
    if (SHOTS) await mkdir(shotDir, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      // A fresh install follows the OS, and the README's frame is the
      // neon one.
      colorScheme: "dark",
      reducedMotion: "no-preference",
    });

    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".app");
    await page.getByText(lastRow).first().waitFor();
    // The boot animation is 700ms and runs once. Let it finish before the
    // capture starts rather than trimming it off afterwards — this is the
    // whole reason the screencast begins here and not with the context.
    await wait(900);
    const stop = SHOTS ? null : await startScreencast(page);

    let n = 0;
    const beat = async (name, hold = 0) => {
      if (hold) await wait(hold);
      if (SHOTS) {
        const file = join(shotDir, `${String(n++).padStart(2, "0")}-${name}.png`);
        await page.screenshot({ path: file });
      }
      log(`beat ${name}`);
    };

    const pointer = await installPointer(page);
    await storyboard(page, beat, {
      dragDivider: () => dragDivider(page, pointer),
      clickRow: (title) => clickRow(page, pointer, title),
    });

    if (SHOTS) {
      await context.close();
      log(`shots in ${shotDir}`);
      return;
    }

    const frames = await stop();
    await context.close();
    // The gif loops, so the last frame is also the pause before it starts
    // over. Long enough to read the frame it ends on, short enough that
    // nobody thinks it has stopped.
    const list = await writeFrames(frames, join(work, "frames"), 1.6);
    log(`captured ${frames.length} frames`);

    const gif = join(ROOT, "assets", "demo.gif");
    await encode(list, gif);
    log(`wrote ${gif}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await stopServer(server);
    if (!KEEP) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
