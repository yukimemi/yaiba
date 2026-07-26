//! `yaiba` — 刃. A vim-flavoured todo & gantt manager that runs as a
//! single local binary and opens its UI in the browser.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;
use yaiba::projects::{self, Registry};
use yaiba::updater::{self, UpdateMode};
use yaiba::{api, app};
use yaiba_core::Store;
use yaiba_sync::{Ticket, Transport};

/// `ya-i-ba` → 8-1-8. Arbitrary, but memorable and well clear of the
/// usual dev-server ports.
const DEFAULT_PORT: u16 = 8188;

/// How long the join hand-off waits for the peer before handing the UI
/// over to the background sync driver.
const FIRST_SYNC: Duration = Duration::from_secs(10);

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

    /// Don't launch a browser on startup.
    #[arg(long, global = true)]
    no_open: bool,

    /// Merge the *current* project into another replica's group.
    ///
    /// This is not "open their project": both task sets end up in both
    /// replicas, and this replica leaves its own sync room for theirs.
    /// To keep them apart use the `yaiba join <ticket>` subcommand, which
    /// files the peer as a separate project with its own database.
    #[arg(long, global = true, value_name = "TICKET")]
    join: Option<String>,

    /// Run fully local: no peer-to-peer endpoint is bound at all.
    #[arg(long, global = true)]
    no_sync: bool,

    /// Sync through relays only, binding no socket of our own.
    ///
    /// For a machine without administrator rights: the normal endpoint
    /// listens on every interface and probes the router, and Windows
    /// answers that with a firewall prompt on every start that nobody
    /// there can dismiss for good. Set `YAIBA_RELAY_ONLY` to make it
    /// permanent. The direct peer-to-peer path is what this gives up —
    /// syncing keeps working, it just always goes the long way round.
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
    /// Read for presence like `YAIBA_NO_AUTOUPDATE`, not through clap's
    /// `env`: clap parses a flag's environment value as a bool, so
    /// `YAIBA_RELAY_ONLY=1` — the spelling everyone reaches for, and the
    /// one an admin-less machine would set once and forget — refuses to
    /// *start* with "invalid value '1'". Failing to launch is a far
    /// worse answer than accepting a loose truthy value.
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
    /// you already have are neither changed nor shared with them.
    Join {
        /// The ticket they printed on startup, or copied with `:ticket`.
        ticket: String,
        /// File it under this name. Defaults to a name from the ticket.
        #[arg(long = "as", value_name = "NAME")]
        name: Option<String>,
    },

    /// Open a registered project. Without a name, pick one interactively.
    Open {
        /// Project name. Omit to fuzzy-pick from the registry.
        name: Option<String>,
    },

    /// List registered projects.
    List,

    /// Drop a project from the registry. Its database is left on disk.
    Forget {
        /// Project name, as shown by `yaiba list`.
        name: String,
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
}

/// Why a ticket is being joined. `SyncNode::join` does the same thing
/// either way — the distinction is what it *means*, and only the registry
/// cares: a merged project was not adopted from anyone, so labelling it
/// `(joined)` in `yaiba list` would be a plain lie.
#[derive(Debug)]
enum Peer {
    /// `join` subcommand: their tasks arrive as this new project.
    Adopt(Ticket),
    /// `--join` flag: the project being opened moves into their room.
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

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("YAIBA_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    // Subcommands that don't start a server run instead of it.
    match &cli.command {
        Some(Command::SelfUpdate {
            check,
            yes,
            non_interactive,
        }) => return updater::run_self_update(*yes, *check, *non_interactive).await,
        Some(Command::List) => return list_projects(),
        Some(Command::Forget { name }) => return forget_project(name),
        _ => {}
    }

    // Kick the update check off before the slower startup work so it
    // overlaps with opening the database and binding sockets.
    updater::spawn(cli.update);

    // A registry failure is only fatal for the commands that need one —
    // `yaiba --db <path>` has to keep working on a machine where the
    // platform data directory can't be resolved at all.
    let registry = Registry::load();
    let target = resolve_target(&cli, &registry)?;

    let store = Store::open(&target.db)
        .with_context(|| format!("failed to open database at {}", target.db.display()))?;
    let node_id = store.node_id();

    // Register before any network work. The project exists the moment its
    // database does, so a peer that turns out to be unreachable must not
    // cost the user the name they just chose — otherwise `yaiba join`
    // against an offline peer leaves an unnamed database behind and the
    // next attempt silently reuses it.
    let project = remember(registry, &target);

    let mut state = api::AppState::new(store);

    // Peer-to-peer replication. Bound before the HTTP listener so the
    // ticket is on screen by the time the UI opens.
    let relay_only = cli.relay_only();
    let mut ticket = None;
    if !cli.no_sync {
        let transport = if relay_only {
            Transport::RelayOnly
        } else {
            Transport::Direct
        };
        let sync = yaiba_sync::SyncNode::start_with(Arc::clone(&state.store), transport)
            .await
            .context("failed to start the peer-to-peer sync endpoint")?;
        if let Some(peer) = &target.peer {
            sync.join(peer.ticket())
                .context("could not join the peer from that ticket")?;
            // Pull immediately: joining should show their tasks now, not
            // after the first idle tick. Bounded, because a peer that is
            // simply switched off would otherwise hold the whole startup
            // — including the UI — for as long as iroh keeps dialling. The
            // background driver retries on its own timer, so a slow first
            // handshake costs a delay, never the data.
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
        tokio::spawn(Arc::clone(&sync).run(Arc::clone(&state.notify)));
        state.sync = Some(sync);
    }

    let router = app(state);

    let addr: SocketAddr = format!("{}:{}", cli.host, cli.port)
        .parse()
        .with_context(|| format!("invalid host/port: {}:{}", cli.host, cli.port))?;
    let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| {
        format!(
            "failed to bind {addr} — is yaiba already running? \
             A second project needs its own --port."
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

    banner(
        &url,
        &target.db,
        project.as_deref(),
        node_id,
        ticket.as_deref(),
        relay_only,
    );
    if !cli.no_open {
        open_browser(&url);
    }

    axum::serve(listener, router)
        .await
        .context("server terminated unexpectedly")?;
    Ok(())
}

/// Work out which database to open, and what — if anything — to join.
fn resolve_target(cli: &Cli, registry: &Result<Registry>) -> Result<Target> {
    if cli.join.is_some() {
        // Both name a peer and they mean opposite things. Checked before
        // either ticket is parsed, so a conflict reports as a conflict
        // rather than as whichever ticket happens to be malformed.
        if matches!(cli.command, Some(Command::Join { .. })) {
            bail!(
                "--join and the `join` subcommand both name a peer, and they do \
                 opposite things; pass only one"
            );
        }
        if cli.no_sync {
            bail!("--no-sync and --join ask for opposite things");
        }
        // Warn every time. The surprising half is that the merge is
        // mutual — this replica's tasks are pushed to them too — and no
        // wording on the flag itself can undo that surprise.
        tracing::warn!(
            "--join merges this project with the peer: both task sets end up on both sides, \
             and this replica leaves its own sync room. Use `yaiba join <ticket>` to open \
             theirs as a separate project instead."
        );
    }
    let legacy_join = cli
        .join
        .as_deref()
        .map(parse_ticket)
        .transpose()?
        .map(Peer::Merge);

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
            if registry.find(&name).is_some() {
                bail!(
                    "a project named {name:?} is already registered — open it with \
                     `yaiba open {name}`, or choose another name with --as"
                );
            }

            let db = match &cli.db {
                Some(path) => path.clone(),
                None => {
                    // A free *name* does not mean a free *file*: the path
                    // is `slug(name)`, so "work" and "work!" both land on
                    // projects/work.db. Joining into an existing database
                    // would overwrite its room key and cut its peer off —
                    // the exact hazard the subcommand exists to avoid.
                    let path = registry.joined_db_path(&name)?;
                    if let Some(existing) = registry.find_by_db(&path) {
                        bail!(
                            "{:?} would share a database with the project {:?} ({}) — \
                             open that one with `yaiba open {}`, or choose a name that \
                             differs by more than punctuation",
                            name,
                            existing.name,
                            // The registered path, not the one just built:
                            // it is normalized, so it reads as a real path.
                            existing.db.display(),
                            existing.name
                        );
                    }
                    if path.exists() {
                        bail!(
                            "{} already exists but no project is registered for it \
                             (forgotten earlier?). Choose another name with --as, or \
                             pass --db {} to join into that database deliberately",
                            path.display(),
                            path.display()
                        );
                    }
                    path
                }
            };
            Ok(Target {
                db,
                peer: Some(Peer::Adopt(peer)),
                name_hint: Some(name),
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
                peer: legacy_join,
                name_hint: None,
            })
        }

        _ => {
            let db = match &cli.db {
                Some(path) => path.clone(),
                None => Registry::default_db()?,
            };
            Ok(Target {
                db,
                peer: legacy_join,
                name_hint: None,
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
            "no projects are registered yet — run `yaiba` once, or \
             `yaiba join <ticket> --as {name}`"
        )
    } else {
        anyhow!(
            "no project named {name:?}. Registered: {}",
            registry.names().join(", ")
        )
    }
}

fn registry_ref(registry: &Result<Registry>) -> Result<&Registry> {
    registry
        .as_ref()
        .map_err(|e| anyhow!("could not read the project registry: {e:#}"))
}

/// File the open database in the registry. Best-effort on purpose: a
/// registry that can't be written costs a name, not a session.
fn remember(registry: Result<Registry>, target: &Target) -> Option<String> {
    let mut registry = match registry {
        Ok(registry) => registry,
        Err(e) => {
            tracing::warn!("project registry unavailable: {e:#}");
            return None;
        }
    };
    // Only an adopted project carries a ticket. A `--join` merge did not
    // come from a peer, so stamping it would make `yaiba list` claim it did.
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
    let registry = Registry::load()?;
    if registry.is_empty() {
        println!(
            "no projects registered yet.\n  \
             run `yaiba` once to register the default one, or \
             `yaiba join <ticket>` to add a peer's."
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

fn forget_project(name: &str) -> Result<()> {
    let mut registry = Registry::load()?;
    let Some(project) = registry.forget(name) else {
        return Err(unknown_project(&registry, name));
    };
    registry.save()?;
    println!(
        "forgot {name:?}. Its database is still at {}",
        project.db.display()
    );
    Ok(())
}

fn banner(
    url: &str,
    db_path: &std::path::Path,
    project: Option<&str>,
    node_id: yaiba_core::NodeId,
    ticket: Option<&str>,
    relay_only: bool,
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
            Some(name) => format!("  {CYAN}▸{RESET} pj   {MAGENTA}{name}{RESET}\n"),
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

/// Best-effort browser launch. A failure here is cosmetic — the URL is
/// already on screen — so it warns instead of aborting startup.
fn open_browser(url: &str) {
    #[cfg(target_os = "windows")]
    // The empty string is `start`'s title argument; without it a quoted
    // URL would be consumed as the window title and nothing opens.
    let spawned = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(url).spawn();

    if let Err(e) = spawned {
        tracing::warn!("could not open a browser automatically: {e}");
    }
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

    #[test]
    fn the_flag_and_the_subcommand_together_are_refused() {
        let cli = Cli::parse_from(["yaiba", "--join", "a.b", "join", "c.d"]);
        let err = resolve_target(&cli, &Registry::load()).unwrap_err();
        assert!(err.to_string().contains("only one"), "{err}");
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

    #[test]
    fn the_subcommand_adopts_and_the_flag_merges() {
        let cli = Cli::parse_from(["yaiba", "join", TICKET, "--as", "work"]);
        let target = resolve_target(&cli, &scratch_registry()).unwrap();
        assert!(matches!(target.peer, Some(Peer::Adopt(_))));
        assert_eq!(target.name_hint.as_deref(), Some("work"));

        let cli = Cli::parse_from(["yaiba", "--db", "mine.db", "--join", TICKET]);
        let target = resolve_target(&cli, &scratch_registry()).unwrap();
        assert!(matches!(target.peer, Some(Peer::Merge(_))));
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
