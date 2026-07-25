//! Release-time smoke test for yaiba.
//!
//! `release.yml` runs this on every build-matrix entry after
//! `cargo build --release`. It exercises the startup path against the
//! *produced artifact*, which catches three regressions that a passing
//! `cargo test` does not:
//!
//! 1. **Bundled SQLite** — the migration runs and a task round-trips.
//!    `rusqlite`'s `bundled` feature compiles C; a cross-build that
//!    silently linked the wrong thing fails here rather than on a
//!    user's first launch.
//! 2. **The embedded SPA is actually in the binary.** A release built
//!    without `cargo make web-build` still compiles and still starts —
//!    it just serves an empty shell. This is the single most likely way
//!    to ship a broken `yaiba`, so the check asserts on real markup
//!    from the bundle, not merely on a 200.
//! 3. **The iroh endpoint binds**, dragging in rustls. A sibling
//!    project shipped a `CryptoProvider` panic that only fired at
//!    runtime; binding here forces that path during the release build.
//!
//! Cost: a couple of seconds, one temp directory, no network — the iroh
//! endpoint binds locally and its relay work happens in the background,
//! so an offline runner still passes.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use yaiba::{api::AppState, app};
use yaiba_core::{NewTask, Store};

#[tokio::main]
async fn main() -> Result<()> {
    let dir = std::env::temp_dir().join(format!("yaiba-smoke-{}", std::process::id()));
    let db = dir.join("smoke.db");

    // 1. bundled SQLite: open, migrate, write, read back.
    let mut store = Store::open(&db).context("opening a fresh database")?;
    let created = store
        .create_task(NewTask {
            title: "smoke".into(),
            ..Default::default()
        })
        .context("creating a task")?;
    let snapshot = store.snapshot().context("reading the store back")?;
    if snapshot.tasks.len() != 1 || snapshot.tasks[0].id != created.id {
        bail!("the store did not return the task it just wrote");
    }

    // 2. the embedded bundle: serve it over a real socket.
    let state = AppState::new(store);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .context("binding a loopback port")?;
    let addr = listener.local_addr()?;
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await });

    let state_json = get(addr, "/api/state").await?;
    if !state_json.contains("\"tasks\"") {
        bail!("/api/state did not return the expected payload: {state_json}");
    }

    let index = get(addr, "/").await?;
    // `<div id="root">` comes from the Vite template; its absence means
    // web/dist/ was empty at compile time.
    if !index.contains("id=\"root\"") || !index.contains("/assets/") {
        bail!(
            "the embedded web bundle is missing — build it with \
             `cargo make web-build` before `cargo build --release`"
        );
    }

    server.abort();

    // 3. the iroh endpoint, and with it rustls.
    let store = Arc::new(std::sync::Mutex::new(
        Store::open(&db).context("reopening the database for the sync node")?,
    ));
    let sync = yaiba_sync::SyncNode::start(store)
        .await
        .context("binding the peer-to-peer endpoint")?;
    let ticket = sync.ticket().to_string();
    if ticket.parse::<yaiba_sync::Ticket>().is_err() {
        bail!("the generated ticket does not parse: {ticket}");
    }

    std::fs::remove_dir_all(&dir).ok();
    println!("smoke OK: sqlite + embedded UI + iroh endpoint all live");
    Ok(())
}

/// Minimal HTTP/1.1 GET against the loopback server.
///
/// Hand-rolled rather than pulling an HTTP client into dev-dependencies:
/// a smoke test that ships with the release should add as little to the
/// build as possible, and `Connection: close` makes reading the whole
/// response a single `read_to_end`. Retries because the server task may
/// not have reached `accept` on the first attempt.
async fn get(addr: std::net::SocketAddr, path: &str) -> Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut last: Option<std::io::Error> = None;
    for _ in 0..30 {
        match tokio::net::TcpStream::connect(addr).await {
            Ok(mut stream) => {
                let request =
                    format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
                stream.write_all(request.as_bytes()).await?;
                let mut buf = Vec::new();
                stream.read_to_end(&mut buf).await?;
                let text = String::from_utf8_lossy(&buf).into_owned();
                if !text.starts_with("HTTP/1.1 200") {
                    bail!("GET {path} returned: {}", text.lines().next().unwrap_or(""));
                }
                return Ok(text);
            }
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
    Err(last.map_or_else(|| anyhow::anyhow!("no attempt made"), Into::into))
        .with_context(|| format!("GET {path}"))
}
