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
    /// you already have are neither changed nor shared with them.
    Join {
        /// The ticket they printed on startup, or copied with `:ticket`.
        ticket: String,
        /// File it under this name. Defaults to a name from the ticket.
        #[arg(long = "as", value_name = "NAME")]
        name: Option<String>,
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
        Some(Command::Rename { from, to }) => return rename_project(from, to),
        Some(Command::Forget { name }) => return forget_project(name),
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
                Ok(sync) => project.sync = Some(sync),
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
    for project in state.projects() {
        if let Some(sync) = &project.sync {
            tokio::spawn(Arc::clone(sync).run(Arc::clone(&project.notify)));
        }
    }

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
        // `new` builds a project with no peer, so the ticket would be
        // accepted, warned about, and then quietly dropped. Asking for an
        // empty project that immediately merges into someone's room is
        // spelled `yaiba join <ticket> --as <name>` — which does it
        // properly rather than by accident.
        if let Some(Command::New { name }) = &cli.command {
            bail!(
                "--join has nothing to merge into a project that does not exist yet. \
                 To take a peer's tasks as a new project, use \
                 `yaiba join <ticket> --as {name}`"
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
    registry.rename(from, to)?;
    registry.save()?;
    let renamed = registry.find(to.trim()).map(|p| p.db.display().to_string());
    println!("renamed {from:?} to {:?}", to.trim());
    // Say it plainly rather than let someone discover it when `new work`
    // is refused later: the file keeps the old name.
    if let Some(db) = renamed {
        println!("  its database is still {db}");
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

    /// `new` builds a project with no peer, so a ticket handed to it was
    /// warned about and then silently dropped — the user asked to join
    /// someone and got a plain local project.
    #[test]
    fn the_flag_and_new_together_are_refused() {
        let cli = Cli::parse_from(["yaiba", "--join", TICKET, "new", "work"]);
        let err = resolve_target(&cli, &scratch_registry()).unwrap_err();
        assert!(err.to_string().contains("nothing to merge"), "{err}");
        // The message has to name the command that does what they meant.
        assert!(err.to_string().contains("join <ticket> --as work"), "{err}");
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
