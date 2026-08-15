//! `yaiba` — 刃. A vim-flavoured todo & gantt manager that runs as a
//! single local binary and opens its UI in the browser.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;
use yaiba::browser;
use yaiba::gcal;
use yaiba::projects::{self, Registry};
use yaiba::updater::{self, UpdateMode};
use yaiba::{api, app, mcp};
use yaiba_core::Store;
use yaiba_core::calendar;
use yaiba_sync::{Ticket, Transport};

/// `ya-i-ba` → 8-1-8. Arbitrary, but memorable and well clear of the
/// usual dev-server ports.
const DEFAULT_PORT: u16 = 8188;

/// How long the join hand-off waits for the peer before handing the UI
/// over to the background sync driver.
const FIRST_SYNC: Duration = Duration::from_secs(10);

/// `yaiba gcal <action>`, run against a yaiba that is already up.
///
/// A client, not a second writer — the same arrangement `mcp` is in, and
/// the honest failure is the same one: if nothing is running there is
/// nothing to talk to, and starting a server from in here would mean
/// guessing a port and a project.
async fn gcal_command(action: GcalAction, url: Option<String>, open: bool) -> Result<()> {
    let base = url.unwrap_or_else(|| format!("http://127.0.0.1:{DEFAULT_PORT}"));
    let http = gcal::http();

    match action {
        GcalAction::Login => {
            // No server in this arm at all. The credential is the
            // person's and lands in their own credentials file, so
            // nothing here touches a project — which also means the
            // reachability check this used to need is gone, along with
            // the failure it guarded: a consent flow completed and then
            // thrown away because nobody was listening.
            let creds = gcal::oauth::Credentials::from_env()?;
            let token = gcal::oauth::consent(&creds, open).await?;
            gcal::oauth::store(&token)?;
            println!(
                "yaiba can now write to your calendar. `yaiba gcal push` puts the plan on it."
            );
            Ok(())
        }

        GcalAction::Push => {
            let response = http
                .post(format!("{base}/api/gcal/push"))
                .send()
                .await
                .with_context(|| unreachable_yaiba(&base))?;
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if !status.is_success() {
                // The server already writes a sentence worth reading —
                // the missing-credential case names the command to run,
                // and a rejected refresh names the seven-day rule. Pass
                // it through rather than wrapping it in a second one.
                let text: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                bail!("{}", text["error"].as_str().unwrap_or(body.as_str()));
            }

            let outcome: gcal::push::Outcome =
                serde_json::from_str(&body).context("yaiba answered something unexpected")?;
            if outcome.quiet() {
                println!("The calendar already says what the plan says.");
            } else {
                println!(
                    "{} added, {} updated, {} removed.",
                    outcome.inserted, outcome.patched, outcome.deleted
                );
            }
            // Never folded into the counts: a run that half landed looks
            // exactly like one that landed, and the events it missed are
            // the ones nobody thinks to check.
            for refusal in &outcome.refused {
                println!("  {refusal}");
            }
            Ok(())
        }
    }
}

fn unreachable_yaiba(base: &str) -> String {
    format!(
        "no yaiba answering at {base}. This talks to a running one rather than starting its \
         own, so the server stays the only writer — leave `yaiba` up in another window"
    )
}

/// `yaiba cal [action]`, run against a yaiba that is already up.
///
/// A client of the HTTP API rather than a second writer — the same
/// arrangement `gcal` and `mcp` are in, and the same honest failure when
/// nothing is listening.
///
/// It exists beside the app's own `:cal` because a calendar usually
/// *arrives* as a file: a company's shutdown days, a country's holidays
/// somebody exported. Typing fifty dates one at a time into a command line
/// is not a way to enter them, so `--file` reads them and posts the lot in
/// **one** request. That is not only for typing: the server validates the
/// whole map before it writes any of it, so a file with one bad line
/// changes nothing, where fifty requests would leave the calendar halfway.
async fn cal_command(action: Option<CalAction>, url: Option<String>) -> Result<()> {
    let base = url.unwrap_or_else(|| format!("http://127.0.0.1:{DEFAULT_PORT}"));
    let http = gcal::http();

    // Built before anything is sent, so a bad week spec or an unreadable
    // file costs no request at all.
    let patch = match &action {
        // A bare `yaiba cal` reports, exactly as a bare `:cal` does. The
        // reasoning is the gcal one: this is the entry point that reaches a
        // write, so the word on its own must not be one.
        None => None,
        Some(CalAction::On) => Some(serde_json::json!({ "mode": "workdays" })),
        Some(CalAction::Off) => Some(serde_json::json!({ "mode": "days" })),
        Some(CalAction::Week { spec }) => {
            // Parsed here because the API takes the mask and nothing else:
            // the words are a typing convenience, and keeping them out of
            // the wire format is what stops the two clients' vocabularies
            // from becoming two behaviours.
            let week = calendar::parse_week_spec(spec).ok_or_else(|| {
                anyhow!(
                    "{spec} is not a week — name one of {}, or spell seven days Monday-first \
                     like 1111100",
                    calendar::WEEK_WORDS
                        .iter()
                        .map(|(word, _)| *word)
                        .collect::<Vec<_>>()
                        .join(" or ")
                )
            })?;
            Some(serde_json::json!({ "week": week }))
        }
        // Sent as typed. The server owns the list of regions it knows and
        // names them in its refusal, so checking here would be a second
        // copy that goes stale the day another one is added.
        Some(CalAction::Region { name }) => Some(serde_json::json!({ "region": name })),
        Some(CalAction::Holiday { date, name, file }) => Some(serde_json::json!({
            "days": day_map(date.as_deref(), name.as_deref(), file.as_deref(), Mark::Off)?
        })),
        Some(CalAction::Workday { date, file }) => Some(serde_json::json!({
            "days": day_map(date.as_deref(), None, file.as_deref(), Mark::Worked)?
        })),
        Some(CalAction::Clear { date, file }) => Some(serde_json::json!({
            "days": day_map(date.as_deref(), None, file.as_deref(), Mark::Forget)?
        })),
    };

    let marked = patch
        .as_ref()
        .and_then(|p| p.get("days"))
        .and_then(|days| days.as_object())
        .map(serde_json::Map::len);

    let response = match &patch {
        Some(patch) => http.put(format!("{base}/api/calendar")).json(patch).send(),
        None => http.get(format!("{base}/api/state")).send(),
    }
    .await
    .with_context(|| unreachable_yaiba(&base))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // The server's refusals are the sentence worth reading — the bad
        // date, the empty week, the region it does not know and what to do
        // instead. Passed through rather than wrapped in a second one.
        let text: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        bail!("{}", text["error"].as_str().unwrap_or(body.as_str()));
    }

    let state: CalState =
        serde_json::from_str(&body).context("yaiba answered something unexpected")?;
    if let Some(days) = marked {
        // Phrased to read the same for one day as for fifty: "1 day marked
        // as days off" is the sort of sentence a plural branch is for.
        let verb = match action {
            Some(CalAction::Workday { .. }) => "marked as worked",
            Some(CalAction::Clear { .. }) => "cleared",
            _ => "marked off",
        };
        println!("{days} {} {verb}.", if days == 1 { "day" } else { "days" });
    }
    // Every write answers with where the plan then stands, which is the
    // bargain the rest of yaiba makes: the calendar is only interesting
    // for what it does to the dates.
    print!("{}", state.report());
    Ok(())
}

/// Which of the three things a marking verb says about a day.
#[derive(Clone, Copy)]
enum Mark {
    Off,
    Worked,
    Forget,
}

impl Mark {
    /// The patch value for this mark. `null` is how a day is forgotten:
    /// LWW has no delete, so "no opinion" has to be written as one.
    fn value(self, name: &str) -> serde_json::Value {
        match self {
            Self::Off if name.is_empty() => serde_json::Value::Bool(true),
            Self::Off => serde_json::Value::String(name.to_string()),
            Self::Worked => serde_json::Value::Bool(false),
            Self::Forget => serde_json::Value::Null,
        }
    }
}

/// The `days` map for a marking verb: either the one date on the command
/// line, or every date in a file.
///
/// Dates are passed through as typed rather than parsed here. The server
/// validates them and names the one it choked on, and a second parser here
/// would only be able to disagree with it.
fn day_map(
    date: Option<&str>,
    name: Option<&str>,
    file: Option<&std::path::Path>,
    mark: Mark,
) -> Result<serde_json::Map<String, serde_json::Value>> {
    let mut days = serde_json::Map::new();
    if let Some(path) = file {
        let text = if path == std::path::Path::new("-") {
            std::io::read_to_string(std::io::stdin()).context("could not read stdin")?
        } else {
            std::fs::read_to_string(path)
                .with_context(|| format!("could not read {}", path.display()))?
        };
        let lines = parse_day_file(&text);
        if lines.is_empty() {
            bail!(
                "{} named no days — one `date[,name]` per line, `#` for a comment",
                path.display()
            );
        }
        for (day, label) in lines {
            days.insert(day, mark.value(&label));
        }
    }
    if let Some(day) = date {
        days.insert(day.to_string(), mark.value(name.unwrap_or_default()));
    }
    Ok(days)
}

/// `date[,name]` a line, `#` comments and blank lines skipped.
///
/// Deliberately not a CSV library. The format is two fields whose second is
/// free text that may itself contain a comma — "Christmas Eve, half day" —
/// so the split is on the **first** separator and everything after it is
/// the name. Quoting rules would be a spec nobody asked for and a file
/// nobody could write by hand.
///
/// A tab counts as the separator too, because a spreadsheet exporting one
/// column of dates and one of names is as likely to produce TSV, and the
/// leading BOM Excel writes is stripped — otherwise the first date arrives
/// as `\u{feff}2026-01-01` and the server refuses it with a message that
/// looks like nonsense.
fn parse_day_file(text: &str) -> Vec<(String, String)> {
    text.strip_prefix('\u{feff}')
        .unwrap_or(text)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| match line.find([',', '\t']) {
            Some(at) => (
                line[..at].trim().to_string(),
                line[at + 1..].trim().to_string(),
            ),
            None => (line.to_string(), String::new()),
        })
        .filter(|(day, _)| !day.is_empty())
        .collect()
}

/// Just enough of `/api/state` to say where the calendar stands.
///
/// A local shape rather than the server's own type: this is an API client
/// like `mcp` is, and what it reads is what it prints.
#[derive(serde::Deserialize)]
struct CalState {
    calendar: CalView,
    schedule: PlanSpan,
}

#[derive(serde::Deserialize)]
struct CalView {
    mode: String,
    week: [bool; 7],
    region: String,
    /// Day off → its name. Weekends are not in here; see the API.
    holidays: std::collections::BTreeMap<String, String>,
    workdays: Vec<String>,
}

#[derive(serde::Deserialize)]
struct PlanSpan {
    end: String,
}

impl CalState {
    fn report(&self) -> String {
        let counting = if self.calendar.mode == "workdays" {
            "working days"
        } else {
            "calendar days"
        };
        format!(
            "counting   {counting}\n\
             week       {}\n\
             holidays   {}\n\
             in view    {} off, {} worked\n\
             plan ends  {}\n",
            calendar::week_word(self.calendar.week),
            self.calendar.region,
            self.calendar.holidays.len(),
            self.calendar.workdays.len(),
            self.schedule.end,
        )
    }
}

#[derive(Parser, Debug)]
#[command(
    name = "yaiba",
    version,
    about = "刃 — vim-flavoured todo & gantt, one binary",
    long_about = None
)]
struct Cli {
    /// Optional subcommand. Without one, `yaiba` starts the server —
    /// which is what you want the overwhelming majority of the time.
    #[command(subcommand)]
    command: Option<Command>,

    // Every flag below is `global` so it reads the same before or after a
    // subcommand: `yaiba open work --port 9000` is what people type, and
    // without this clap rejects it outright.
    /// Port to listen on.
    #[arg(short, long, global = true, default_value_t = DEFAULT_PORT, env = "YAIBA_PORT")]
    port: u16,

    /// Address to bind. Defaults to loopback; set 0.0.0.0 to expose the
    /// UI on your LAN (there is no authentication, so only do that on a
    /// network you trust).
    #[arg(long, global = true, default_value = "127.0.0.1", env = "YAIBA_HOST")]
    host: String,

    /// Database file. Defaults to the platform data dir.
    ///
    /// This names one database. To move the whole root — the project
    /// registry, the default database and the joined ones — set
    /// `YAIBA_DATA_DIR`.
    #[arg(long, global = true, env = "YAIBA_DB")]
    db: Option<PathBuf>,

    /// Don't launch a browser — on startup, or for the `gcal login`
    /// consent screen. Both print the URL either way, which is what makes
    /// this usable over SSH rather than a way to lose the address.
    #[arg(long, global = true)]
    no_open: bool,

    /// Removed. Parsed only so it can say what to use instead.
    ///
    /// This flag and the `join` subcommand were one word for two opposite
    /// things — the flag merged your project into theirs, the subcommand
    /// opened theirs beside yours — and since the merge cannot be undone,
    /// guessing wrong cost people the separation they had set up. They
    /// are `merge` and `join` now.
    ///
    /// Hidden from `--help`, because there is nothing to recommend about
    /// it. Still *parsed*, because a flag that simply vanishes gets
    /// clap's "unexpected argument" — which says nothing about which of
    /// the two you meant, and this is exactly the flag whose users need
    /// telling.
    #[arg(long, global = true, hide = true, value_name = "TICKET")]
    join: Option<String>,

    /// Run fully local: no peer-to-peer endpoint is bound at all.
    #[arg(long, global = true)]
    no_sync: bool,

    /// Open only the project asked for, not every registered one.
    ///
    /// Opening them all is what makes `:proj` switching instant and keeps
    /// every project replicating. This is the way out if that costs more
    /// than it is worth — a long registry, a slow disk, a metered link.
    #[arg(long, global = true)]
    only_active: bool,

    /// Sync through relays only, binding no UDP socket to do it.
    ///
    /// For a machine without administrator rights: the normal endpoint
    /// listens on every interface and probes the router, and Windows
    /// answers that with a firewall prompt on every start that nobody
    /// there can dismiss for good. Set `YAIBA_RELAY_ONLY` to make it
    /// permanent. The UI keeps its loopback listener either way — a
    /// firewall has never had anything to say about that one. The direct
    /// peer-to-peer path is what this gives up: syncing keeps working,
    /// it just always goes the long way round.
    #[arg(long, global = true)]
    relay_only: bool,

    /// What to do when a newer release exists: install it quietly in the
    /// background, only say so, or never look. `YAIBA_NO_AUTOUPDATE`
    /// overrides this to off.
    #[arg(long, global = true, value_enum, default_value_t, env = "YAIBA_UPDATE")]
    update: UpdateMode,
}

impl Cli {
    /// `--relay-only`, or the environment variable standing in for it.
    ///
    /// Set means *set to something*, matching how
    /// `updater::disabled_by_env` reads `YAIBA_NO_AUTOUPDATE`: an empty
    /// `YAIBA_RELAY_ONLY=` is off, which is what clearing a variable
    /// means everywhere else, and two environment flags in one binary
    /// disagreeing about that would be its own trap.
    ///
    /// Not clap's `env`, which parses a flag's environment value as a
    /// bool: `YAIBA_RELAY_ONLY=1` — the spelling everyone reaches for,
    /// and the one an admin-less machine would set once and forget —
    /// refuses to *start* with "invalid value '1'". Failing to launch is
    /// a far worse answer than accepting a loose truthy value.
    fn relay_only(&self) -> bool {
        self.relay_only || std::env::var_os("YAIBA_RELAY_ONLY").is_some_and(|v| !v.is_empty())
    }
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Update yaiba to the latest release.
    SelfUpdate {
        /// Report whether an update exists, then exit without installing.
        #[arg(long)]
        check: bool,
        /// Install without asking.
        #[arg(long, short)]
        yes: bool,
        /// Never prompt. Combine with `--yes` to install unattended.
        #[arg(long)]
        non_interactive: bool,
    },

    /// Join another replica as a *separate* project, and open it.
    ///
    /// The peer's tasks land in a database of their own, so the projects
    /// you already have are neither changed nor shared with them. This is
    /// the one to reach for; `merge` is the one that mixes two task sets
    /// together.
    Join {
        /// The ticket they printed on startup, or copied with `:ticket`.
        ticket: String,
        /// File it under this name. Defaults to a name from the ticket.
        #[arg(long = "as", value_name = "NAME")]
        name: Option<String>,
    },

    /// Merge a project of yours into another replica's group.
    ///
    /// The opposite of `join`, and the destructive one: both task sets
    /// end up in *both* replicas, this project leaves its own sync room
    /// for theirs, and none of it can be undone. Reach for it only when
    /// two replicas are meant to become one plan — to work alongside
    /// someone while keeping your projects apart, use `join`.
    Merge {
        /// The ticket they printed on startup, or copied with `:ticket`.
        ticket: String,
        /// Merge this project rather than the one that would open by
        /// default. Names a registered project, as `yaiba list` shows it.
        #[arg(long, value_name = "NAME")]
        project: Option<String>,
    },

    /// Leave the group a project is in, and go back to syncing with
    /// nobody.
    ///
    /// The way out of both `join` and `merge`: the project's peers are
    /// forgotten and it moves to a room of its own. Its tasks are
    /// untouched — including the ones that arrived from the group, which
    /// are yours to keep or delete once you are out. Delete them *after*
    /// leaving; before, the deletions replicate.
    ///
    /// Two things it does not do. It cannot take back what already
    /// reached them, since their replica is as complete as yours. And it
    /// changes this project's ticket, so *every* replica holding the old
    /// one is cut off — your own other machines included. Share the new
    /// ticket to pair up again.
    Leave {
        /// Leave this project rather than the one that would open by
        /// default. Names a registered project, as `yaiba list` shows it.
        #[arg(long, value_name = "NAME")]
        project: Option<String>,
    },

    /// Start a project of your own, and open it.
    ///
    /// For keeping things apart that should be apart — a backlog you
    /// share with someone and one you don't. Nothing is shared until you
    /// hand out its ticket.
    New {
        /// What to call it. Becomes `projects/<name>.db`.
        name: String,
    },

    /// Open a registered project. Without a name, pick one interactively.
    Open {
        /// Project name. Omit to fuzzy-pick from the registry.
        name: Option<String>,
    },

    /// List registered projects.
    List,

    /// Give a project a different name.
    ///
    /// Only the name changes: the database keeps the file it was created
    /// with, so a project renamed away from `work` still lives in
    /// `projects/work.db`, and that filename stays claimed.
    Rename {
        /// The name it has now, as shown by `yaiba list`.
        from: String,
        /// What to call it instead.
        to: String,
    },

    /// Drop a project from the registry. Its database is left on disk.
    Forget {
        /// Project name, as shown by `yaiba list`.
        name: String,
    },

    /// Serve the plan to an agent over MCP, on stdio.
    ///
    /// Register it with `claude mcp add yaiba -- yaiba mcp`. This talks to
    /// a yaiba that is already running rather than starting one, so the
    /// server stays the only writer — leave `yaiba` up in another window.
    Mcp {
        /// The running yaiba to talk to. Defaults to the local one on the
        /// standard port.
        #[arg(long, value_name = "URL", env = "YAIBA_MCP_URL")]
        url: Option<String>,
    },

    /// Put the plan on a Google Calendar.
    ///
    /// Deliberately not spelled `sync`. That word already means
    /// peer-to-peer replication everywhere else in yaiba — the
    /// `yaiba-sync` crate, `SyncNode`, the room a project shares — and
    /// one word meaning two things is exactly what the `join` / `merge`
    /// tangle cost. A longer subcommand is the cheaper side of that.
    ///
    /// Like `mcp`, this talks to a yaiba that is already running rather
    /// than starting one, so the server stays the only writer.
    Gcal {
        #[command(subcommand)]
        action: GcalAction,

        /// The running yaiba to talk to.
        ///
        /// Its own variable rather than sharing `mcp`'s. That one is
        /// named for MCP, and pointing an agent at a second yaiba would
        /// otherwise silently redirect `gcal` as well — one name meaning
        /// two things, which is the trade this repo has already paid for
        /// once.
        #[arg(long, value_name = "URL", env = "YAIBA_GCAL_URL")]
        url: Option<String>,
    },

    /// Read or change the working calendar: what a duration is counted in,
    /// and which days are days off.
    ///
    /// Like `mcp` and `gcal`, this talks to a yaiba that is already running
    /// rather than starting one, so the server stays the only writer.
    ///
    /// The app has `:cal` for the same settings one at a time. This exists
    /// for the case that one is bad at: a calendar that arrives as a file.
    /// `yaiba cal holiday --file days.csv` posts every line in one request.
    Cal {
        #[command(subcommand)]
        action: Option<CalAction>,

        /// The running yaiba to talk to. Its own variable rather than
        /// sharing `mcp`'s or `gcal`'s, for the reason spelled out on
        /// those: one name meaning two things is a trade this repo has
        /// already paid for once.
        #[arg(long, value_name = "URL", env = "YAIBA_CAL_URL")]
        url: Option<String>,
    },
}

#[derive(Subcommand, Debug, Clone)]
enum GcalAction {
    /// Grant yaiba access to your calendar, once.
    ///
    /// The consent flow runs in this process rather than in the server
    /// because the URL has to appear where you typed the command. Only
    /// the resulting token is handed over, and the server is what writes
    /// it down.
    Login,
    /// Reconcile the calendar against the plan.
    ///
    /// Idempotent: it works out the difference and applies it, so a
    /// second run in a row does nothing.
    Push,
}

#[derive(Subcommand, Debug, Clone)]
enum CalAction {
    /// Count durations in working days, skipping weekends and days off.
    On,
    /// Count durations in calendar days — the default, and what every
    /// project did before calendars existed.
    Off,
    /// Set which weekdays are worked.
    Week {
        /// `mon-fri`, `mon-sat`, or seven days Monday-first: `1111100`.
        spec: String,
    },
    /// Choose the bundled holiday table, if any.
    Region {
        /// `jp` for Japan's 国民の祝日, or `none` for a project that marks
        /// its own days. Anywhere else, mark the dates with `holiday
        /// --file` — that is the general mechanism, and a table in the
        /// binary is only a shortcut for one country.
        name: String,
    },
    /// Mark days off.
    Holiday {
        #[arg(required_unless_present = "file")]
        date: Option<String>,
        /// What to call it. Optional — an unlabelled day off is still one.
        name: Option<String>,
        /// Read `date[,name]` lines from a file, or `-` for stdin, and post
        /// them in one request.
        #[arg(long, value_name = "PATH", conflicts_with_all = ["date", "name"])]
        file: Option<PathBuf>,
    },
    /// Mark days worked, against the week mask or the holiday table — a
    /// Saturday everybody is in, or a public holiday the team works
    /// through.
    Workday {
        #[arg(required_unless_present = "file")]
        date: Option<String>,
        /// As `holiday --file`. Any name in the file is ignored here, so
        /// the same file can be handed to either verb.
        #[arg(long, value_name = "PATH", conflicts_with = "date")]
        file: Option<PathBuf>,
    },
    /// Forget whatever was said about these days, leaving the week mask and
    /// the holiday table to decide.
    Clear {
        #[arg(required_unless_present = "file")]
        date: Option<String>,
        /// As `holiday --file`; names are ignored.
        #[arg(long, value_name = "PATH", conflicts_with = "date")]
        file: Option<PathBuf>,
    },
}

/// What the resolved command says to open.
#[derive(Debug)]
struct Target {
    db: PathBuf,
    /// Handed to `SyncNode::join` once the endpoint is up.
    peer: Option<Peer>,
    /// Name to file a *new* database under. An already-registered
    /// database keeps the name it has.
    name_hint: Option<String>,
    /// Cut this project loose once the endpoint is up.
    ///
    /// Runs through the server rather than editing the database from a
    /// second process, even though clearing the peers and minting a room
    /// needs no endpoint at all. A running yaiba holds the room and the
    /// peer set in memory as well as on disk, so a side-door write would
    /// be undone by the next thing that touched either — the same
    /// one-writer rule `mcp` follows for the same reason.
    leave: bool,
}

/// Why a ticket is being joined. `SyncNode::join` does the same thing
/// either way — the distinction is what it *means*, and only the registry
/// cares: a merged project was not adopted from anyone, so labelling it
/// `(joined)` in `yaiba list` would be a plain lie.
#[derive(Debug)]
enum Peer {
    /// `join` subcommand: their tasks arrive as this new project.
    Adopt(Ticket),
    /// `merge` subcommand: the project being opened moves into their
    /// room, and both task sets end up on both sides.
    Merge(Ticket),
}

impl Peer {
    fn ticket(&self) -> &Ticket {
        match self {
            Peer::Adopt(ticket) | Peer::Merge(ticket) => ticket,
        }
    }

    /// The ticket to record on the project, i.e. only when it was adopted.
    fn adopted(&self) -> Option<&Ticket> {
        match self {
            Peer::Adopt(ticket) => Some(ticket),
            Peer::Merge(_) => None,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let filter = EnvFilter::try_from_env("YAIBA_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    if matches!(cli.command, Some(Command::Mcp { .. })) {
        // stdout *is* the MCP protocol. A single log line written there is
        // a parse error at the client, and the symptom is a server that
        // connects and then fails on its first message — nowhere near the
        // logging call that caused it. stderr is still read by the client
        // and is where MCP servers are expected to talk.
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(false)
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(false)
            .init();
    }

    // Subcommands that don't start a server run instead of it.
    match &cli.command {
        Some(Command::SelfUpdate {
            check,
            yes,
            non_interactive,
        }) => return updater::run_self_update(*yes, *check, *non_interactive).await,
        Some(Command::List) => return list_projects(),
        Some(Command::Rename { from, to }) => return rename_project(from, to),
        Some(Command::Forget { name }) => return forget_project(name),
        // Serves an already-running yaiba, so it deliberately skips
        // everything below: no registry, no database, no listener.
        Some(Command::Mcp { url }) => return mcp::serve(url.clone()).await,
        Some(Command::Gcal { action, url }) => {
            return gcal_command(action.clone(), url.clone(), !cli.no_open).await;
        }
        // Serves a running yaiba, so it skips everything below exactly as
        // `mcp` and `gcal` do: no registry, no database, no listener.
        Some(Command::Cal { action, url }) => {
            return cal_command(action.clone(), url.clone()).await;
        }
        _ => {}
    }

    // Kick the update check off before the slower startup work so it
    // overlaps with opening the database and binding sockets.
    updater::spawn(cli.update);

    // A registry failure is only fatal for the commands that need one —
    // `yaiba --db <path>` has to keep working on a machine where the
    // platform data directory can't be resolved at all.
    let mut registry = load_registry();
    let target = resolve_target(&cli, &registry)?;

    let store = Store::open(&target.db)
        .with_context(|| format!("failed to open database at {}", target.db.display()))?;
    let node_id = store.node_id();

    // Register before any network work. The project exists the moment its
    // database does, so a peer that turns out to be unreachable must not
    // cost the user the name they just chose — otherwise `yaiba join`
    // against an offline peer leaves an unnamed database behind and the
    // next attempt silently reuses it.
    let active_name = remember(&mut registry, &target).unwrap_or_else(|| "yaiba".to_string());

    // The active project is first, so it is the one `AppState` starts on.
    let mut projects = vec![api::OpenProject::new(
        active_name.clone(),
        target.db.clone(),
        store,
    )];
    projects.extend(open_others(
        registry.as_ref().ok(),
        &target.db,
        cli.only_active,
    ));

    // Peer-to-peer replication, for *every* open project rather than only
    // the one on screen — that is what makes switching instant instead of
    // a reconnect. Bound before the HTTP listener so the ticket is up by
    // the time the UI opens.
    let mut ticket = None;
    // Carried into `AppState` as well, so a project created from the UI
    // later comes up replicating the same way these do.
    let transport = (!cli.no_sync).then(|| {
        if cli.relay_only() {
            Transport::RelayOnly
        } else {
            Transport::Direct
        }
    });
    if let Some(transport) = transport {
        // Started concurrently: each endpoint spends most of its setup
        // waiting on a relay handshake, so doing them in sequence would
        // make startup scale with the number of projects.
        let starting: Vec<_> = projects
            .iter()
            .map(|project| {
                let store = Arc::clone(&project.store);
                tokio::spawn(
                    async move { yaiba_sync::SyncNode::start_with(store, transport).await },
                )
            })
            .collect();

        for (index, (project, handle)) in projects.iter_mut().zip(starting).enumerate() {
            let started = match handle.await {
                Ok(result) => result,
                Err(e) => Err(anyhow!("the endpoint task did not finish: {e}")),
            };
            match started {
                // Spawns the loop and keeps its handle, so closing the
                // project later can actually stop it.
                Ok(sync) => project.replicate(sync),
                // Index 0 is the project being opened. Only its endpoint is
                // worth failing the launch over — a background project that
                // cannot replicate is still perfectly usable locally, and
                // refusing to start over one would make a stale registry
                // entry able to lock you out of yaiba entirely.
                Err(e) if index == 0 => {
                    return Err(e).context("failed to start the peer-to-peer sync endpoint");
                }
                Err(e) => tracing::warn!(
                    project = %project.name,
                    "could not start replication, continuing without it: {e:#}"
                ),
            }
        }

        if let Some(sync) = &projects[0].sync {
            if target.leave {
                let dropped = sync.leave().context("could not leave the group")?;

                // The label has to come off too, and it will not come off
                // by itself: `remember` above only ever *sets*
                // `joined_from`, so a project adopted from a ticket keeps
                // saying `(joined)` in `yaiba list` and in the picker
                // until something clears it. Left alone it would name a
                // room this replica has just walked out of — and hand out
                // a ticket that now resolves to nobody.
                //
                // Best-effort, and after the leave rather than before:
                // the group is already gone by here, so failing the whole
                // command over a stale label would leave the two
                // disagreeing in the worse direction — out, but reporting
                // itself in.
                if let Ok(registry) = &mut registry
                    && registry.clear_joined_from(&target.db)
                    && let Err(e) = registry.save()
                {
                    tracing::warn!("left the group, but the registry still says joined: {e:#}");
                }

                // Said rather than logged quietly, because the surprising
                // half is what it did to *other* machines: the ticket has
                // moved, so anything holding the old one — including the
                // user's own second laptop — is out until they are handed
                // the new one.
                tracing::info!(
                    "left the group: {dropped} peer(s) dropped, and this project has a new \
                     ticket. Anyone holding the old one is cut off; share the new one to \
                     pair up again. Nothing already synced to them has been taken back."
                );
            }
            if let Some(peer) = &target.peer {
                sync.join(peer.ticket())
                    .context("could not join the peer from that ticket")?;
                // Pull immediately: joining should show their tasks now,
                // not after the first idle tick. Bounded, because a peer
                // that is simply switched off would otherwise hold the
                // whole startup — including the UI — for as long as iroh
                // keeps dialling. The background driver retries on its own
                // timer, so a slow first handshake costs a delay, never the
                // data.
                if tokio::time::timeout(FIRST_SYNC, sync.sync_all())
                    .await
                    .is_err()
                {
                    tracing::warn!(
                        "the peer hasn't answered yet — continuing, and retrying in the background"
                    );
                }
            }
            ticket = Some(sync.ticket().to_string());
        }
    }

    let open_count = projects.len();
    // Counted, not inferred from the active project's ticket: a
    // background project whose endpoint failed to bind is open but not
    // replicating, and the banner must not fold it into "all syncing".
    let syncing_count = projects.iter().filter(|p| p.sync.is_some()).count();
    let state = api::AppState::with_projects(projects, transport);

    let router = app(state);

    let addr: SocketAddr = format!("{}:{}", cli.host, cli.port)
        .parse()
        .with_context(|| format!("invalid host/port: {}:{}", cli.host, cli.port))?;
    let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| {
        format!(
            "failed to bind {addr} — is yaiba already running? \
             One yaiba serves every project, so a second one is only needed \
             for a second port."
        )
    })?;

    // Loopback binds are reached as localhost regardless of the bind
    // address, and 0.0.0.0 isn't a usable URL host on Windows.
    let display_host = if cli.host == "0.0.0.0" || cli.host == "127.0.0.1" {
        "localhost"
    } else {
        cli.host.as_str()
    };
    let url = format!("http://{display_host}:{}", cli.port);

    banner(Banner {
        url: &url,
        db_path: &target.db,
        project: Some(active_name.as_str()),
        open_count,
        syncing_count,
        node_id,
        ticket: ticket.as_deref(),
        relay_only: cli.relay_only(),
    });
    if !cli.no_open {
        browser::open(&url);
    }

    axum::serve(listener, router)
        .await
        .context("server terminated unexpectedly")?;
    Ok(())
}

/// Work out which database to open, and what — if anything — to join.
fn resolve_target(cli: &Cli, registry: &Result<Registry>) -> Result<Target> {
    // One word for two opposite things, and the destructive one had the
    // shorter spelling. Refused rather than mapped onto either: `--join`
    // *did* the merge, so silently routing it to `merge` would keep the
    // accident and silently routing it to `join` would change what a
    // working command does. Only the person typing it knows which they
    // meant, and after this message they can say so.
    if let Some(ticket) = &cli.join {
        bail!(
            "--join has been split in two, because it and the `join` subcommand \
             meant opposite things.\n  \
             yaiba merge {ticket}   — mix both task sets together, in both replicas (not undoable)\n  \
             yaiba join {ticket}    — open their tasks as a separate project of your own"
        );
    }

    match &cli.command {
        Some(Command::Join { ticket, name }) => {
            if cli.no_sync {
                bail!("--no-sync and joining a peer ask for opposite things");
            }
            // Parse before anything is created: a mistyped ticket should
            // not leave an empty database and a registry entry behind.
            let peer = parse_ticket(ticket)?;
            let registry = registry_ref(registry)?;

            let name = match name {
                Some(given) => projects::validate_name(given)?.to_string(),
                None => projects::name_from_ticket(ticket),
            };
            let db = projects::db_for_new_project(
                registry,
                &name,
                cli.db.as_deref(),
                "another name with --as",
            )?;
            Ok(Target {
                db,
                peer: Some(Peer::Adopt(peer)),
                name_hint: Some(name),
                leave: false,
            })
        }

        Some(Command::Merge { ticket, project }) => {
            if cli.no_sync {
                bail!("--no-sync and merging into a peer ask for opposite things");
            }
            if cli.db.is_some() && project.is_some() {
                bail!("--db and --project both choose a database; pass only one");
            }
            let peer = parse_ticket(ticket)?;

            // Named like `open` does, so "merge that one" and "open that
            // one" cannot disagree about which project a name means.
            let db = match (project, &cli.db) {
                (Some(name), _) => {
                    let registry = registry_ref(registry)?;
                    registry
                        .find(name)
                        .ok_or_else(|| unknown_project(registry, name))?
                        .db
                        .clone()
                }
                (None, Some(path)) => path.clone(),
                (None, None) => Registry::default_db()?,
            };

            // Said every time, and said before it happens. The half that
            // surprises people is that it is mutual — their tasks arrive
            // here *and* this project's tasks are pushed to them — which
            // no amount of wording on the subcommand itself can convey to
            // somebody who has already typed it.
            tracing::warn!(
                "merging {} into the peer's group: both task sets end up on both sides, \
                 this replica leaves its own sync room, and none of it can be undone. \
                 `yaiba join <ticket>` opens theirs as a separate project instead.",
                db.display()
            );

            Ok(Target {
                db,
                peer: Some(Peer::Merge(peer)),
                name_hint: None,
                leave: false,
            })
        }

        Some(Command::Leave { project }) => {
            if cli.no_sync {
                bail!(
                    "--no-sync and leaving a group ask for opposite things: leaving writes to \
                     the project through its replication, and --no-sync starts none"
                );
            }
            if cli.db.is_some() && project.is_some() {
                bail!("--db and --project both choose a database; pass only one");
            }
            // Resolved exactly as `merge` resolves it, so "leave that one"
            // and "merge that one" cannot disagree about which project a
            // name means.
            let db = match (project, &cli.db) {
                (Some(name), _) => {
                    let registry = registry_ref(registry)?;
                    registry
                        .find(name)
                        .ok_or_else(|| unknown_project(registry, name))?
                        .db
                        .clone()
                }
                (None, Some(path)) => path.clone(),
                (None, None) => Registry::default_db()?,
            };

            // Before it happens, like `merge`'s. The half people do not
            // expect is not that they stop syncing — they asked for that —
            // it is that the ticket moves, so their *own* other machines
            // go with the peers.
            tracing::warn!(
                "leaving the group {} is in: its peers are forgotten and it moves to a room \
                 of its own, so every replica holding its current ticket is cut off — your \
                 other machines too. Nothing already synced to them is taken back.",
                db.display()
            );

            Ok(Target {
                db,
                peer: None,
                name_hint: None,
                leave: true,
            })
        }

        Some(Command::New { name }) => {
            let name = projects::validate_name(name)?.to_string();
            let registry = registry_ref(registry)?;
            let db = projects::db_for_new_project(
                registry,
                &name,
                cli.db.as_deref(),
                "a different name",
            )?;
            Ok(Target {
                db,
                peer: None,
                name_hint: Some(name),
                leave: false,
            })
        }

        Some(Command::Open { name }) => {
            if cli.db.is_some() {
                bail!("--db and `yaiba open` both choose a database; pass only one");
            }
            let registry = registry_ref(registry)?;
            let project = match name {
                Some(name) => registry
                    .find(name)
                    .ok_or_else(|| unknown_project(registry, name))?,
                None => projects::pick(&registry.recent())?,
            };
            Ok(Target {
                db: project.db.clone(),
                peer: None,
                name_hint: None,
                leave: false,
            })
        }

        _ => {
            let db = match &cli.db {
                Some(path) => path.clone(),
                None => Registry::default_db()?,
            };
            Ok(Target {
                db,
                peer: None,
                name_hint: None,
                leave: false,
            })
        }
    }
}

fn parse_ticket(raw: &str) -> Result<Ticket> {
    raw.parse()
        .with_context(|| format!("could not read the ticket {raw:?}"))
}

/// "Registered: " followed by nothing is a worse message than saying the
/// registry is empty, which is the state a first-time user is actually in.
fn unknown_project(registry: &Registry, name: &str) -> anyhow::Error {
    if registry.is_empty() {
        anyhow!(
            "no projects yet — run `yaiba` to start one, or \
             `yaiba join <ticket> --as {name}`"
        )
    } else {
        anyhow!(
            "no project named {name:?}. Registered: {}",
            registry.names().join(", ")
        )
    }
}

/// Load the registry and adopt the default database if it is on disk but
/// unlisted.
///
/// Every entry point goes through this. Registration used to happen only
/// when the server started, so a fresh install saw `yaiba list` report
/// nothing and `yaiba open` open an empty picker until they had run the
/// server once — with their tasks sitting in the default database the
/// whole time.
fn load_registry() -> Result<Registry> {
    let mut registry = Registry::load()?;
    // Persist the adoption rather than only displaying it. The index is
    // meant to be hand-edited, and you cannot rename an entry that exists
    // only in memory — leaving it unsaved would reintroduce "run the
    // server once first" for anyone wanting to rename their default.
    // Best-effort: a registry that cannot be written still lists and opens
    // correctly, so a read-only home directory costs a warning, not the
    // command.
    if registry.seed_default()
        && let Err(e) = registry.save()
    {
        tracing::warn!("could not save the project registry: {e:#}");
    }
    Ok(registry)
}

fn registry_ref(registry: &Result<Registry>) -> Result<&Registry> {
    registry
        .as_ref()
        .map_err(|e| anyhow!("could not read the project registry: {e:#}"))
}

/// Open every *other* registered project, so all of them replicate and
/// switching between them is instant.
///
/// A registry entry whose database has gone is skipped with a warning
/// rather than failing the launch: the registry is an index, and a stale
/// line in it must not stop yaiba starting. Same for one that won't open —
/// only the active project is worth refusing to start over.
fn open_others(
    registry: Option<&Registry>,
    active_db: &std::path::Path,
    only_active: bool,
) -> Vec<api::OpenProject> {
    let mut opened = Vec::new();
    if only_active {
        return opened;
    }
    let Some(registry) = registry else {
        return opened;
    };
    for project in registry.recent() {
        if projects::same_db(&project.db, active_db) {
            continue;
        }
        if !project.db.exists() {
            tracing::warn!(
                project = %project.name,
                path = %project.db.display(),
                "registered database is missing; skipping (`yaiba forget` to drop it)"
            );
            continue;
        }
        match Store::open(&project.db) {
            Ok(store) => opened.push(api::OpenProject::new(
                project.name.clone(),
                project.db.clone(),
                store,
            )),
            Err(e) => tracing::warn!(
                project = %project.name,
                "could not open, skipping: {e:#}"
            ),
        }
    }
    opened
}

/// File the open database in the registry. Best-effort on purpose: a
/// registry that can't be written costs a name, not a session.
///
/// Takes `&mut` rather than consuming: the caller still needs the registry
/// afterwards to know which *other* projects to open.
fn remember(registry: &mut Result<Registry>, target: &Target) -> Option<String> {
    let registry = match registry {
        Ok(registry) => registry,
        Err(e) => {
            tracing::warn!("project registry unavailable: {e:#}");
            return None;
        }
    };
    // Only an adopted project carries a ticket. A `merge` did not come
    // from a peer, so stamping it would make `yaiba list` claim it did.
    let joined_from = target
        .peer
        .as_ref()
        .and_then(Peer::adopted)
        .map(ToString::to_string);
    let name = match registry.remember(
        &target.db,
        target.name_hint.as_deref(),
        joined_from.as_deref(),
    ) {
        Ok(name) => name,
        Err(e) => {
            tracing::warn!("could not register this project: {e:#}");
            return None;
        }
    };
    if let Err(e) = registry.save() {
        tracing::warn!("could not save the project registry: {e:#}");
    }
    Some(name)
}

fn list_projects() -> Result<()> {
    let registry = load_registry()?;
    if registry.is_empty() {
        println!(
            "no projects yet.\n  \
             run `yaiba` to start one, or `yaiba join <ticket>` to add a peer's."
        );
        return Ok(());
    }
    println!("{:<20} {:<12} DATABASE", "NAME", "LAST OPENED");
    for project in registry.recent() {
        let when = project
            .last_opened
            .map(|t| t.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| "never".to_string());
        let joined = if project.joined_from.is_some() {
            "  (joined)"
        } else {
            ""
        };
        println!(
            "{:<20} {:<12} {}{}",
            project.name,
            when,
            project.db.display(),
            joined
        );
    }
    println!("\nregistry: {}", registry.path().display());
    Ok(())
}

fn rename_project(from: &str, to: &str) -> Result<()> {
    let mut registry = load_registry()?;
    if registry.find(from).is_none() {
        return Err(unknown_project(&registry, from));
    }
    // `Registry::rename` trims, so bind the trimmed form once rather than
    // recompute it at each use and risk the two drifting apart.
    let to = projects::validate_name(to)?;
    registry.rename(from, to)?;
    registry.save()?;
    println!("renamed {from:?} to {to:?}");
    // Say it plainly rather than let someone find out when a later
    // `new work` is refused: the file keeps the old name.
    if let Some(project) = registry.find(to) {
        println!("  its database is still {}", project.db.display());
    }
    Ok(())
}

fn forget_project(name: &str) -> Result<()> {
    let mut registry = load_registry()?;
    let Some(project) = registry.forget(name) else {
        return Err(unknown_project(&registry, name));
    };
    let was_default = registry.is_default_db(&project);
    registry.save()?;
    println!(
        "forgot {name:?}. Its database is still at {}",
        project.db.display()
    );
    // Say so rather than let it look like the forget failed: the default
    // database is re-adopted by `seed_default` on the very next command.
    // Adoption keys off the file existing, and nothing else — `--db`
    // changes which database *you* open, so it does not suppress this.
    if was_default {
        println!(
            "  (that is the default database, so any yaiba command adopts it \
             again — move the file itself to keep it out of the list)"
        );
    }
    Ok(())
}

/// What the startup banner has to say.
///
/// A struct rather than eight positional arguments: two `Option<&str>`
/// and two `usize` next to each other are trivially swappable at the call
/// site, and nothing would catch it.
struct Banner<'a> {
    url: &'a str,
    db_path: &'a std::path::Path,
    project: Option<&'a str>,
    open_count: usize,
    syncing_count: usize,
    node_id: yaiba_core::NodeId,
    ticket: Option<&'a str>,
    relay_only: bool,
}

fn banner(
    Banner {
        url,
        db_path,
        project,
        open_count,
        syncing_count,
        node_id,
        ticket,
        relay_only,
    }: Banner<'_>,
) {
    const CYAN: &str = "\x1b[38;5;51m";
    const MAGENTA: &str = "\x1b[38;5;207m";
    const DIM: &str = "\x1b[2m";
    const RESET: &str = "\x1b[0m";

    println!(
        r#"
{CYAN}  ██╗   ██╗ █████╗ ██╗██████╗  █████╗
  ╚██╗ ██╔╝██╔══██╗██║██╔══██╗██╔══██╗
   ╚████╔╝ ███████║██║██████╔╝███████║
    ╚██╔╝  ██╔══██║██║██╔══██╗██╔══██║
     ██║   ██║  ██║██║██████╔╝██║  ██║
     ╚═╝   ╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝  ╚═╝{RESET}
        {MAGENTA}刃{RESET} {DIM}— cut through the backlog{RESET}

  {CYAN}▸{RESET} ui   {url}
{project}  {CYAN}▸{RESET} db   {db}
  {CYAN}▸{RESET} node {node_id}
{peering}
  {DIM}press ? in the UI for keybindings{RESET}
"#,
        db = db_path.display(),
        project = match project {
            Some(name) => format!(
                "  {CYAN}▸{RESET} pj   {MAGENTA}{name}{RESET}{others}\n",
                // Say how many others are live, so the background
                // replication isn't invisible — and only claim they are
                // syncing when they are. `--no-sync` leaves none of them
                // replicating, and a background endpoint that failed to
                // bind is warned about and skipped, so a count is the only
                // honest source for this.
                others = match open_count {
                    0 | 1 => String::new(),
                    n => format!(
                        "{DIM}  +{} more open{} · :proj{RESET}",
                        n - 1,
                        match syncing_count {
                            0 => String::new(),
                            s if s == n => ", all syncing".to_string(),
                            s => format!(", {s} of {n} syncing"),
                        }
                    ),
                }
            ),
            None => String::new(),
        },
        peering = match ticket {
            Some(ticket) => format!(
                "  {CYAN}▸{RESET} share {MAGENTA}{ticket}{RESET}\n       \
                 {DIM}they run: yaiba join <that ticket>{RESET}{relay}",
                relay = if relay_only {
                    format!("\n  {DIM}▸ sync  relay-only (--relay-only){RESET}")
                } else {
                    String::new()
                }
            ),
            None => format!("  {DIM}▸ sync  off (--no-sync){RESET}"),
        }
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_cli_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn a_bare_cal_asks_for_nothing() {
        // The word on its own has to be a read. `:cal` in the app makes the
        // same promise, and for the reason `check-gcal.ts` spells out: the
        // entry point that reaches a write must not *be* one on an early ⏎.
        let cli = Cli::parse_from(["yaiba", "cal"]);
        match cli.command {
            Some(Command::Cal { action, .. }) => assert!(action.is_none()),
            other => panic!("expected cal, got {other:?}"),
        }
    }

    #[test]
    fn a_marking_verb_wants_a_date_or_a_file_and_not_both() {
        let cli = Cli::parse_from(["yaiba", "cal", "holiday", "2026-12-29", "年末休み"]);
        match cli.command {
            Some(Command::Cal {
                action: Some(CalAction::Holiday { date, name, file }),
                ..
            }) => {
                assert_eq!(date.as_deref(), Some("2026-12-29"));
                assert_eq!(name.as_deref(), Some("年末休み"));
                assert!(file.is_none());
            }
            other => panic!("expected a holiday, got {other:?}"),
        }

        assert!(
            Cli::try_parse_from(["yaiba", "cal", "holiday"]).is_err(),
            "a date or a file, but not neither"
        );
        assert!(
            Cli::try_parse_from([
                "yaiba",
                "cal",
                "holiday",
                "2026-12-29",
                "--file",
                "days.csv"
            ])
            .is_err(),
            "a date or a file, but not both"
        );
        assert!(
            Cli::try_parse_from(["yaiba", "cal", "workday", "--file", "-"]).is_ok(),
            "stdin is a file"
        );
    }

    #[test]
    fn a_day_file_is_one_date_and_an_optional_name_per_line() {
        let parsed = parse_day_file(
            "\u{feff}# 2026, as the office keeps it\n\
             \n\
             2026-12-29,年末休み\n\
             2026-12-30\n\
             2026-12-31\tNew Year's Eve\n\
             2026-01-04 , Christmas Eve, half day \n",
        );
        assert_eq!(
            parsed,
            vec![
                ("2026-12-29".to_string(), "年末休み".to_string()),
                ("2026-12-30".to_string(), String::new()),
                ("2026-12-31".to_string(), "New Year's Eve".to_string()),
                // Split on the *first* separator, so a comma inside a name
                // survives instead of truncating it.
                (
                    "2026-01-04".to_string(),
                    "Christmas Eve, half day".to_string()
                ),
            ]
        );
        assert!(parse_day_file("# nothing but a comment\n\n").is_empty());
    }

    #[test]
    fn a_day_map_carries_what_each_verb_means() {
        // The three marks are three values, and `null` is the one that says
        // "no opinion" — LWW has no delete, so forgetting has to be written.
        let off = day_map(Some("2026-05-01"), Some("創立記念日"), None, Mark::Off).unwrap();
        assert_eq!(off["2026-05-01"], serde_json::json!("創立記念日"));

        let unnamed = day_map(Some("2026-05-01"), None, None, Mark::Off).unwrap();
        assert_eq!(unnamed["2026-05-01"], serde_json::json!(true));

        let worked = day_map(Some("2026-08-15"), None, None, Mark::Worked).unwrap();
        assert_eq!(worked["2026-08-15"], serde_json::json!(false));

        let forgotten = day_map(Some("2026-08-15"), None, None, Mark::Forget).unwrap();
        assert_eq!(forgotten["2026-08-15"], serde_json::Value::Null);
    }

    #[test]
    fn join_takes_a_ticket_and_an_optional_name() {
        let cli = Cli::parse_from(["yaiba", "join", "abc.def", "--as", "work"]);
        match cli.command {
            Some(Command::Join { ticket, name }) => {
                assert_eq!(ticket, "abc.def");
                assert_eq!(name.as_deref(), Some("work"));
            }
            other => panic!("expected a join command, got {other:?}"),
        }
    }

    #[test]
    fn open_without_a_name_is_the_picker() {
        let cli = Cli::parse_from(["yaiba", "open"]);
        assert!(matches!(cli.command, Some(Command::Open { name: None })));
    }

    /// Regression guard: without `global = true` clap rejects this
    /// outright, and every flag silently becomes prefix-only.
    #[test]
    fn flags_are_accepted_after_a_subcommand() {
        let cli = Cli::parse_from(["yaiba", "open", "work", "--port", "9000", "--no-open"]);
        assert_eq!(cli.port, 9000);
        assert!(cli.no_open);
    }

    #[test]
    fn open_and_db_together_are_refused() {
        let cli = Cli::parse_from(["yaiba", "open", "work", "--db", "x.db"]);
        let err = resolve_target(&cli, &Registry::load()).unwrap_err();
        assert!(err.to_string().contains("--db"), "{err}");
    }

    #[test]
    fn a_malformed_ticket_fails_before_any_database_is_touched() {
        let cli = Cli::parse_from(["yaiba", "join", "not-a-ticket"]);
        assert!(resolve_target(&cli, &Registry::load()).is_err());
    }

    /// The old flag is gone, and saying so is the whole of its job now.
    /// A bare "unexpected argument" would leave somebody holding a ticket
    /// and two commands that do opposite things with it.
    #[test]
    fn the_old_flag_names_both_of_its_replacements() {
        let cli = Cli::parse_from(["yaiba", "--join", TICKET]);
        let err = resolve_target(&cli, &Registry::load())
            .unwrap_err()
            .to_string();
        assert!(err.contains(&format!("yaiba merge {TICKET}")), "{err}");
        assert!(err.contains(&format!("yaiba join {TICKET}")), "{err}");
    }

    /// Hidden, but still parsed — the point is the message above, and a
    /// flag clap does not know about cannot produce one.
    #[test]
    fn the_old_flag_is_parsed_and_hidden() {
        let cmd = Cli::command();
        let arg = cmd
            .get_arguments()
            .find(|a| a.get_id() == "join")
            .expect("--join still has to parse");
        assert!(arg.is_hide_set(), "nothing to recommend about it");
    }

    /// Regression guard for the reason `relay_only()` exists: hand the
    /// variable to clap as a flag `env` instead and `YAIBA_RELAY_ONLY=1`
    /// makes yaiba refuse to start.
    #[test]
    fn relay_only_does_not_parse_its_environment_value_as_a_bool() {
        let cmd = Cli::command();
        let arg = cmd
            .get_arguments()
            .find(|a| a.get_id() == "relay_only")
            .expect("--relay-only should be defined");
        assert!(arg.get_env().is_none(), "presence is read by relay_only()");
        assert!(Cli::parse_from(["yaiba", "open", "work", "--relay-only"]).relay_only);
    }

    #[test]
    fn joining_with_sync_off_is_refused() {
        let cli = Cli::parse_from(["yaiba", "--no-sync", "join", "abc.def"]);
        let err = resolve_target(&cli, &Registry::load()).unwrap_err();
        assert!(err.to_string().contains("--no-sync"), "{err}");
    }

    #[test]
    fn plain_startup_honours_db() {
        let cli = Cli::parse_from(["yaiba", "--db", "somewhere.db"]);
        let target = resolve_target(&cli, &Registry::load()).unwrap();
        assert_eq!(target.db, PathBuf::from("somewhere.db"));
        assert!(target.peer.is_none());
        assert!(target.name_hint.is_none());
    }

    /// A real ticket, so the parse in `resolve_target` gets past its own
    /// validation and the assertions land on the logic under test.
    const TICKET: &str = "aeb122f4e5a9ca05aaa8d41479711bfbda9e5532c05e2d1a697b7573654d05ee.\
                          2d75eb9bc13af1cefb8ded97fb64f874effaedecf4bb1af5a39c8025d5b8588d";

    /// A registry in its own directory, so these tests never read or write
    /// the machine's real one — `joined_db_path` follows the registry.
    fn scratch_registry() -> Result<Registry> {
        use std::time::{SystemTime, UNIX_EPOCH};
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "yaiba-cli-{stamp}-{:?}",
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Registry::load_from(dir.join("projects.toml"))
    }

    fn names(projects: &[api::OpenProject]) -> Vec<&str> {
        projects.iter().map(|p| p.name.as_str()).collect()
    }

    /// A real database on disk for the registry to point at.
    fn seed_db(registry: &Registry, name: &str) -> PathBuf {
        let path = registry.path().parent().unwrap().join(format!("{name}.db"));
        Store::open(&path).unwrap();
        path
    }

    /// The active database is already open as index 0. Opening it again
    /// would give one project two SQLite handles and set it replicating
    /// against itself.
    #[test]
    fn the_active_database_is_not_opened_twice() {
        let mut registry = scratch_registry().unwrap();
        let active = seed_db(&registry, "yaiba");
        registry.remember(&active, Some("default"), None).unwrap();

        let opened = open_others(Some(&registry), &active, false);
        assert!(opened.is_empty(), "opened {:?}", names(&opened));
    }

    /// The claim the launch rests on: a stale registry line costs a
    /// warning, never the startup.
    #[test]
    fn a_registered_database_that_is_gone_is_skipped() {
        let mut registry = scratch_registry().unwrap();
        let here = seed_db(&registry, "here");
        let vanished = registry.path().parent().unwrap().join("vanished.db");
        registry.remember(&here, Some("here"), None).unwrap();
        registry
            .remember(&vanished, Some("vanished"), None)
            .unwrap();

        let opened = open_others(Some(&registry), &PathBuf::from("elsewhere.db"), false);
        assert_eq!(names(&opened), vec!["here"]);
    }

    /// A path that exists but is not a database — a directory left where a
    /// file used to be — must not take the launch down either.
    #[test]
    fn a_database_that_will_not_open_is_skipped() {
        let mut registry = scratch_registry().unwrap();
        let good = seed_db(&registry, "good");
        let bad = registry.path().parent().unwrap().join("bad.db");
        std::fs::create_dir_all(&bad).unwrap();
        registry.remember(&good, Some("good"), None).unwrap();
        registry.remember(&bad, Some("bad"), None).unwrap();

        let opened = open_others(Some(&registry), &PathBuf::from("elsewhere.db"), false);
        assert_eq!(names(&opened), vec!["good"]);
    }

    #[test]
    fn only_active_opens_nothing_else() {
        let mut registry = scratch_registry().unwrap();
        let other = seed_db(&registry, "other");
        registry.remember(&other, Some("other"), None).unwrap();

        assert!(open_others(Some(&registry), &PathBuf::from("elsewhere.db"), true).is_empty());
    }

    #[test]
    fn no_registry_means_only_the_active_project() {
        assert!(open_others(None, &PathBuf::from("elsewhere.db"), false).is_empty());
    }

    /// `merge` names a project that already exists, so an unknown name is
    /// a usage error rather than a new database — the trap the old flag
    /// fell into with `new`, where the ticket was warned about and then
    /// silently dropped.
    #[test]
    fn merging_into_an_unknown_project_is_refused() {
        let cli = Cli::parse_from(["yaiba", "merge", TICKET, "--project", "nope"]);
        let err = resolve_target(&cli, &scratch_registry())
            .unwrap_err()
            .to_string();
        assert!(err.contains("nope"), "{err}");
    }

    /// `escape` lands inside "or choose {escape}", so a bare flag name
    /// reads as a dangling fragment. Nothing pinned `join`'s wording, which
    /// is how sharing the helper regressed it in the first place.
    #[test]
    fn both_callers_word_their_refusal_as_a_sentence() {
        let mut registry = scratch_registry().unwrap();
        let db = registry.joined_db_path("work").unwrap();
        registry.remember(&db, Some("work"), None).unwrap();
        let registry = Ok(registry);

        let join = Cli::parse_from(["yaiba", "join", TICKET, "--as", "work"]);
        let err = resolve_target(&join, &registry).unwrap_err().to_string();
        assert!(err.contains("choose another name with --as"), "{err}");

        let new = Cli::parse_from(["yaiba", "new", "work"]);
        let err = resolve_target(&new, &registry).unwrap_err().to_string();
        assert!(err.contains("choose a different name"), "{err}");
    }

    /// The gap this closes: before `new`, starting a project of your own
    /// meant knowing that `--db <path>` quietly registers what it opens.
    #[test]
    fn new_starts_a_project_with_no_peer() {
        let registry = scratch_registry().unwrap();
        let cli = Cli::parse_from(["yaiba", "new", "private"]);
        let target = resolve_target(&cli, &Ok(registry)).unwrap();

        assert_eq!(target.name_hint.as_deref(), Some("private"));
        assert!(target.peer.is_none(), "a new project is nobody's replica");
        assert!(target.db.ends_with("private.db"));
        assert!(
            !target.db.exists(),
            "the database is created by the open, not here"
        );
    }

    /// `new` and `join` share `db_for_new_project`, so they refuse the same
    /// collisions — a name already taken, and a name whose slug lands on
    /// another project's file.
    #[test]
    fn new_refuses_a_name_that_is_taken() {
        let mut registry = scratch_registry().unwrap();
        let db = registry.joined_db_path("private").unwrap();
        registry.remember(&db, Some("private"), None).unwrap();

        let cli = Cli::parse_from(["yaiba", "new", "private"]);
        let err = resolve_target(&cli, &Ok(registry)).unwrap_err();
        assert!(err.to_string().contains("already registered"), "{err}");
    }

    #[test]
    fn new_refuses_a_name_that_would_share_a_database() {
        let mut registry = scratch_registry().unwrap();
        let db = registry.joined_db_path("private").unwrap();
        registry.remember(&db, Some("private"), None).unwrap();

        let cli = Cli::parse_from(["yaiba", "new", "private!"]);
        let err = resolve_target(&cli, &Ok(registry)).unwrap_err();
        assert!(err.to_string().contains("share a database"), "{err}");
    }

    #[test]
    fn new_refuses_an_orphaned_database() {
        let registry = scratch_registry().unwrap();
        let db = registry.joined_db_path("ghost").unwrap();
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        std::fs::write(&db, b"pretend this holds tasks").unwrap();

        let cli = Cli::parse_from(["yaiba", "new", "ghost"]);
        let err = resolve_target(&cli, &Ok(registry)).unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
    }

    /// Naming the file yourself is a choice, not a collision.
    #[test]
    fn new_with_db_puts_the_database_where_you_say() {
        let registry = scratch_registry().unwrap();
        let cli = Cli::parse_from(["yaiba", "new", "private", "--db", "elsewhere.db"]);
        let target = resolve_target(&cli, &Ok(registry)).unwrap();
        assert_eq!(target.db, PathBuf::from("elsewhere.db"));
    }

    #[test]
    fn new_rejects_a_name_that_is_not_usable_as_a_file() {
        let registry = scratch_registry().unwrap();
        let cli = Cli::parse_from(["yaiba", "new", "a/b"]);
        assert!(resolve_target(&cli, &Ok(registry)).is_err());
    }

    #[test]
    fn join_adopts_and_merge_merges() {
        let cli = Cli::parse_from(["yaiba", "join", TICKET, "--as", "work"]);
        let target = resolve_target(&cli, &scratch_registry()).unwrap();
        assert!(matches!(target.peer, Some(Peer::Adopt(_))));
        assert_eq!(target.name_hint.as_deref(), Some("work"));

        let cli = Cli::parse_from(["yaiba", "--db", "mine.db", "merge", TICKET]);
        let target = resolve_target(&cli, &scratch_registry()).unwrap();
        assert!(matches!(target.peer, Some(Peer::Merge(_))));
        assert!(
            target.name_hint.is_none(),
            "a merge joins a project that already exists"
        );
    }

    /// `leave` names no peer, which is the whole of what makes it the way
    /// back out — every other path here needs a ticket from somebody.
    #[test]
    fn leave_names_a_project_and_no_peer() {
        let cli = Cli::parse_from(["yaiba", "--db", "mine.db", "leave"]);
        let target = resolve_target(&cli, &scratch_registry()).unwrap();
        assert!(target.leave);
        assert!(
            target.peer.is_none(),
            "there is nobody to dial on the way out"
        );
        assert!(target.name_hint.is_none(), "and no project to invent");
        assert_eq!(target.db, PathBuf::from("mine.db"));
    }

    /// Resolved the same way `merge` resolves it: "leave that one" and
    /// "merge that one" must not disagree about which project a name is.
    #[test]
    fn leaving_an_unknown_project_is_refused() {
        let cli = Cli::parse_from(["yaiba", "leave", "--project", "nope"]);
        let err = resolve_target(&cli, &scratch_registry())
            .unwrap_err()
            .to_string();
        assert!(err.contains("nope"), "{err}");
    }

    /// Leaving is a write, and `--no-sync` starts nothing to write it
    /// with — so the pair would silently do nothing at all.
    #[test]
    fn leaving_with_no_sync_is_refused() {
        let cli = Cli::parse_from(["yaiba", "--no-sync", "leave"]);
        assert!(resolve_target(&cli, &scratch_registry()).is_err());
    }

    /// A merge is not an adoption, so it must not leave a ticket on the
    /// project — `yaiba list` would then call it `(joined)`, which it isn't.
    #[test]
    fn only_an_adopted_project_records_a_ticket() {
        let ticket: Ticket = TICKET.parse().unwrap();
        assert!(Peer::Adopt(ticket.clone()).adopted().is_some());
        assert!(Peer::Merge(ticket).adopted().is_none());
    }

    /// `slug()` maps both names onto `projects/work.db`, and joining into an
    /// existing database would overwrite its room key — the very hazard the
    /// subcommand exists to avoid.
    #[test]
    fn names_that_differ_only_by_punctuation_cannot_share_a_database() {
        let mut registry = scratch_registry().unwrap();
        let db = registry.joined_db_path("work").unwrap();
        registry.remember(&db, Some("work"), Some(TICKET)).unwrap();

        let cli = Cli::parse_from(["yaiba", "join", TICKET, "--as", "work!"]);
        let err = resolve_target(&cli, &Ok(registry)).unwrap_err();
        assert!(err.to_string().contains("share a database"), "{err}");
    }

    /// The same collision reached the other way: the file survives a
    /// `yaiba forget`, so a fresh name can still land on somebody's tasks.
    #[test]
    fn an_orphaned_database_is_not_silently_reused() {
        let registry = scratch_registry().unwrap();
        let db = registry.joined_db_path("ghost").unwrap();
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        std::fs::write(&db, b"pretend this holds tasks").unwrap();

        let cli = Cli::parse_from(["yaiba", "join", TICKET, "--as", "ghost"]);
        let err = resolve_target(&cli, &Ok(registry)).unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
    }

    /// …but naming the file outright is a deliberate choice, so it passes.
    #[test]
    fn db_makes_joining_into_an_existing_file_deliberate() {
        let registry = scratch_registry().unwrap();
        let db = registry.joined_db_path("ghost").unwrap();
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        std::fs::write(&db, b"pretend this holds tasks").unwrap();

        let cli = Cli::parse_from([
            "yaiba",
            "join",
            TICKET,
            "--as",
            "ghost",
            "--db",
            db.to_str().unwrap(),
        ]);
        let target = resolve_target(&cli, &Ok(registry)).unwrap();
        assert_eq!(target.db, db);
    }
}
