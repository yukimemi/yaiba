//! `yaiba` — 刃. A vim-flavoured todo & gantt manager that runs as a
//! single local binary and opens its UI in the browser.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use tracing_subscriber::EnvFilter;
use yaiba::{api, app};
use yaiba_core::Store;

/// `ya-i-ba` → 8-1-8. Arbitrary, but memorable and well clear of the
/// usual dev-server ports.
const DEFAULT_PORT: u16 = 8188;

#[derive(Parser, Debug)]
#[command(
    name = "yaiba",
    version,
    about = "刃 — vim-flavoured todo & gantt, one binary",
    long_about = None
)]
struct Cli {
    /// Port to listen on.
    #[arg(short, long, default_value_t = DEFAULT_PORT, env = "YAIBA_PORT")]
    port: u16,

    /// Address to bind. Defaults to loopback; set 0.0.0.0 to expose the
    /// UI on your LAN (there is no authentication, so only do that on a
    /// network you trust).
    #[arg(long, default_value = "127.0.0.1", env = "YAIBA_HOST")]
    host: String,

    /// Database file. Defaults to the platform data dir.
    #[arg(long, env = "YAIBA_DB")]
    db: Option<PathBuf>,

    /// Don't launch a browser on startup.
    #[arg(long)]
    no_open: bool,

    /// Join another replica using the ticket it printed on startup.
    /// Stored, so this is only needed once per peer.
    #[arg(long, value_name = "TICKET")]
    join: Option<String>,

    /// Run fully local: no peer-to-peer endpoint is bound at all.
    #[arg(long)]
    no_sync: bool,
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

    let db_path = match cli.db {
        Some(path) => path,
        None => dirs::data_dir()
            .context("could not determine the platform data directory; pass --db")?
            .join("yaiba")
            .join("yaiba.db"),
    };

    let store = Store::open(&db_path)
        .with_context(|| format!("failed to open database at {}", db_path.display()))?;
    let node_id = store.node_id();
    let mut state = api::AppState::new(store);

    // Peer-to-peer replication. Bound before the HTTP listener so the
    // ticket is on screen by the time the UI opens.
    let mut ticket = None;
    if !cli.no_sync {
        let sync = yaiba_sync::SyncNode::start(Arc::clone(&state.store))
            .await
            .context("failed to start the peer-to-peer sync endpoint")?;
        if let Some(raw) = &cli.join {
            let parsed = raw
                .parse()
                .with_context(|| format!("could not read the ticket {raw:?}"))?;
            sync.join(&parsed)
                .context("could not join the peer from that ticket")?;
            // Pull immediately: joining should show their tasks now, not
            // after the first idle tick.
            sync.sync_all().await;
        }
        ticket = Some(sync.ticket().to_string());
        tokio::spawn(Arc::clone(&sync).run(Arc::clone(&state.notify)));
        state.sync = Some(sync);
    }

    let router = app(state);

    let addr: SocketAddr = format!("{}:{}", cli.host, cli.port)
        .parse()
        .with_context(|| format!("invalid host/port: {}:{}", cli.host, cli.port))?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind {addr} — is yaiba already running?"))?;

    // Loopback binds are reached as localhost regardless of the bind
    // address, and 0.0.0.0 isn't a usable URL host on Windows.
    let display_host = if cli.host == "0.0.0.0" || cli.host == "127.0.0.1" {
        "localhost"
    } else {
        cli.host.as_str()
    };
    let url = format!("http://{display_host}:{}", cli.port);

    banner(&url, &db_path, node_id, ticket.as_deref());
    if !cli.no_open {
        open_browser(&url);
    }

    axum::serve(listener, router)
        .await
        .context("server terminated unexpectedly")?;
    Ok(())
}

fn banner(url: &str, db_path: &std::path::Path, node_id: yaiba_core::NodeId, ticket: Option<&str>) {
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
  {CYAN}▸{RESET} db   {db}
  {CYAN}▸{RESET} node {node_id}
{peering}
  {DIM}press ? in the UI for keybindings{RESET}
"#,
        db = db_path.display(),
        peering = match ticket {
            Some(ticket) => format!(
                "  {CYAN}▸{RESET} share {MAGENTA}{ticket}{RESET}\n       \
                 {DIM}they run: yaiba --join <that ticket>{RESET}"
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
