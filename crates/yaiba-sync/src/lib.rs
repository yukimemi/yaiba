//! Peer-to-peer replication over iroh.
//!
//! Every `yaiba` instance is a full replica. Syncing is symmetric — no
//! peer is authoritative and none has to be reachable at a fixed
//! address. iroh dials by public key and hole-punches, so peers need
//! outbound UDP and nothing else: no port forwarding, no inbound rule.
//! When hole punching fails the connection falls back to a relay, which
//! only forwards already-encrypted QUIC and cannot read the contents.
//!
//! Hole punching does still bind a socket on every interface, and that
//! is what a desktop firewall asks about on startup.
//! [`Transport::RelayOnly`] gives the direct path up to keep the prompt
//! away.
//!
//! Membership is a shared 32-byte *room key*, handed around inside a
//! ticket. A peer that can't present it is dropped before any data
//! moves.

pub mod proto;

use std::collections::HashSet;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use iroh::endpoint::{Connection, PortmapperConfig};
use iroh::{Endpoint, EndpointId, SecretKey};
use tokio::sync::Notify;
use yaiba_core::Store;

use crate::proto::{Hello, Offer, Push};

const ALPN: &[u8] = b"yaiba/sync/1";

/// How often to reach out to known peers even when nothing changed
/// locally — catches writes made while this replica was offline.
const IDLE_SYNC: Duration = Duration::from_secs(30);

const META_SECRET: &str = "sync_secret_key";
const META_ROOM: &str = "sync_room_key";

/// What you hand someone to bring them into the same dataset.
///
/// Just an endpoint id and the room key: the address is resolved by
/// iroh's discovery, so a ticket stays valid across network changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub endpoint: EndpointId,
    pub room: String,
}

impl std::fmt::Display for Ticket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.endpoint, self.room)
    }
}

impl FromStr for Ticket {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        let (endpoint, room) = s
            .trim()
            .split_once('.')
            .context("a ticket looks like <endpoint-id>.<room-key>")?;
        if from_hex(room).is_none() {
            bail!("the room part of the ticket is not valid hex");
        }
        Ok(Ticket {
            endpoint: endpoint
                .parse()
                .map_err(|e| anyhow!("bad endpoint id in ticket: {e}"))?,
            room: room.to_ascii_lowercase(),
        })
    }
}

/// How the endpoint puts itself on the network.
///
/// The distinction only matters on a machine where the user cannot
/// answer a firewall prompt — see [`Transport::RelayOnly`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Transport {
    /// Bind UDP on every interface and ask the gateway for a port
    /// mapping. Hole punching gets a direct path when it can, and the
    /// relay picks up the rest.
    #[default]
    Direct,
    /// Bind no UDP socket and skip the gateway probe, so everything
    /// rides the relay over an outbound connection.
    ///
    /// Slower — every byte takes the long way round — but nothing ever
    /// listens on a real interface. That is what a machine without
    /// administrator rights needs: binding `0.0.0.0` and the UPnP
    /// discovery multicast are each enough to make Windows raise a
    /// firewall prompt that only an administrator can answer, and one
    /// that is dismissed comes straight back on the next start.
    RelayOnly,
}

pub struct SyncNode {
    endpoint: Endpoint,
    store: Arc<Mutex<Store>>,
    /// Hex room key. Replaced when joining someone else's group.
    room: Mutex<String>,
    peers: Mutex<HashSet<EndpointId>>,
    /// Set by `shutdown`, and the thing that actually makes it stick.
    ///
    /// Aborting the accept loop stops *new* connections being taken, but
    /// each one it already took is served on a detached task nothing
    /// holds a handle to — a dial mid-handshake when shutdown lands goes
    /// on to merge seconds later. `serve` consults this instead, so
    /// refusing does not depend on winning a race with a task.
    closed: AtomicBool,
    /// The inbound half, so replication can actually be stopped.
    ///
    /// Aborting the outbound driver silences only what this replica
    /// *sends*: the accept loop keeps answering dials and merging what
    /// peers push. A caller that has closed a project needs both halves
    /// to stop, or it is still taking writes into a store it no longer
    /// considers open.
    inbound: Mutex<Option<tokio::task::AbortHandle>>,
}

impl SyncNode {
    /// Bind an endpoint and start serving. Identity is persisted, so a
    /// restart rejoins as the same peer with the same ticket.
    pub async fn start(store: Arc<Mutex<Store>>) -> Result<Arc<Self>> {
        Self::start_with(store, Transport::Direct).await
    }

    /// [`SyncNode::start`], choosing how the endpoint reaches the
    /// network. The ticket is the same either way: a peer dials by
    /// public key and never learns which transport answered.
    pub async fn start_with(store: Arc<Mutex<Store>>, transport: Transport) -> Result<Arc<Self>> {
        let (secret, room) = {
            let db = store.lock().unwrap_or_else(|e| e.into_inner());
            let secret = match db.meta(META_SECRET)? {
                Some(hex) => SecretKey::from_bytes(
                    &from_hex(&hex)
                        .and_then(|b| <[u8; 32]>::try_from(b).ok())
                        .context("stored sync secret key is corrupt")?,
                ),
                None => {
                    let key = generate_secret();
                    db.set_meta(META_SECRET, &to_hex(&key.to_bytes()))?;
                    key
                }
            };
            let room = match db.meta(META_ROOM)? {
                Some(room) => room,
                None => {
                    let room = to_hex(&generate_secret().to_bytes());
                    db.set_meta(META_ROOM, &room)?;
                    room
                }
            };
            (secret, room)
        };

        let mut builder = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()]);
        if transport == Transport::RelayOnly {
            // Both halves are needed: dropping the IP transports stops
            // the `0.0.0.0` / `[::]` binds, and disabling the portmapper
            // stops the SSDP multicast that probes for a gateway. Either
            // one alone still trips the firewall.
            builder = builder
                .clear_ip_transports()
                .portmapper_config(PortmapperConfig::Disabled);
        }
        let endpoint = builder
            .bind()
            .await
            .context("failed to bind the iroh endpoint")?;

        let node = Arc::new(Self {
            endpoint,
            store,
            room: Mutex::new(room),
            peers: Mutex::new(HashSet::new()),
            closed: AtomicBool::new(false),
            inbound: Mutex::new(None),
        });

        node.load_peers()?;

        let listener = Arc::clone(&node);
        let accepting = tokio::spawn(async move { listener.accept_loop().await });
        *node.inbound.lock().unwrap_or_else(|e| e.into_inner()) = Some(accepting.abort_handle());

        Ok(node)
    }

    /// Stop replicating, in both directions, and give up the endpoint.
    ///
    /// For a caller that has closed the project this node belongs to.
    /// Aborting their own outbound driver is not enough on its own — the
    /// accept loop here would go on answering dials and merging peer
    /// writes into a store nobody is looking at any more.
    ///
    /// Idempotent: the abort handle is taken, so a second call has nothing
    /// left to abort, and closing an endpoint twice is a no-op.
    ///
    /// Synchronous on purpose — callers reach this while holding a lock
    /// over their own project set, which rules out awaiting here. Aborting
    /// the accept loop is what actually stops peer writes landing, and it
    /// takes effect immediately; the endpoint's graceful close only tells
    /// peers why, so it is spawned rather than waited on.
    pub fn shutdown(&self) {
        // Under the store lock, so this cannot land between a merge's
        // check and the merge itself. A merge already running finishes
        // and this waits for it; none can start afterwards.
        {
            let _db = self.store.lock().unwrap_or_else(|e| e.into_inner());
            self.closed.store(true, Ordering::SeqCst);
        }
        if let Some(task) = self
            .inbound
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            task.abort();
        }
        let endpoint = self.endpoint.clone();
        tokio::spawn(async move { endpoint.close().await });
    }

    pub fn ticket(&self) -> Ticket {
        Ticket {
            endpoint: self.endpoint.id(),
            room: self.room.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        }
    }

    pub fn peer_ids(&self) -> Vec<EndpointId> {
        self.peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .copied()
            .collect()
    }

    /// Adopt a ticket: remember the peer and, since the room key names
    /// the group, switch to theirs.
    ///
    /// Joining is deliberately one-way — the joiner moves to the host's
    /// room rather than negotiating — so "I sent you a ticket" has an
    /// unambiguous result.
    pub fn join(&self, ticket: &Ticket) -> Result<()> {
        if ticket.endpoint == self.endpoint.id() {
            bail!("that ticket is this replica's own");
        }
        {
            let db = self.store.lock().unwrap_or_else(|e| e.into_inner());
            db.set_meta(META_ROOM, &ticket.room)?;
            db.upsert_peer(&ticket.endpoint.to_string(), &ticket.to_string(), "")?;
        }
        *self.room.lock().unwrap_or_else(|e| e.into_inner()) = ticket.room.clone();
        self.peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(ticket.endpoint);
        Ok(())
    }

    fn load_peers(&self) -> Result<()> {
        let stored = {
            let db = self.store.lock().unwrap_or_else(|e| e.into_inner());
            db.list_peers()?
        };
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        for (node, _ticket, _label) in stored {
            if let Ok(id) = node.parse::<EndpointId>() {
                peers.insert(id);
            }
        }
        Ok(())
    }

    /// Background driver: sync on every local change, and on a timer so
    /// peers that were offline still catch up.
    pub async fn run(self: Arc<Self>, notify: Arc<Notify>) {
        loop {
            tokio::select! {
                _ = notify.notified() => {}
                _ = tokio::time::sleep(IDLE_SYNC) => {}
            }
            self.sync_all().await;
        }
    }

    pub async fn sync_all(&self) {
        for peer in self.peer_ids() {
            match self.sync_with(peer).await {
                Ok(applied) if applied > 0 => {
                    tracing::info!(%peer, applied, "merged updates from peer");
                }
                Ok(_) => tracing::debug!(%peer, "peer already up to date"),
                // A peer being offline is the normal case, not an error
                // worth shouting about.
                Err(e) => tracing::debug!(%peer, "sync failed: {e:#}"),
            }
        }
    }

    /// Dial a peer and run one full exchange. Returns how many entries
    /// this replica took from them.
    pub async fn sync_with(&self, peer: EndpointId) -> Result<usize> {
        let conn = self
            .endpoint
            .connect(peer, ALPN)
            .await
            .with_context(|| format!("could not reach {peer}"))?;
        let (mut send, mut recv) = conn.open_bi().await?;

        let hello = Hello {
            room: self.room.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            vv: self.with_store(|db| db.version_vector())?,
        };
        proto::write_frame(&mut send, &hello).await?;

        let offer: Offer = proto::read_frame(&mut recv).await?;
        let applied = self.merge_unless_closed(&offer.entries, &offer.vv)?;

        // Now that their vector is known, send back only what they lack.
        let entries = self.with_store(|db| db.entries_since(&offer.vv))?;
        proto::write_frame(&mut send, &Push { entries }).await?;
        send.finish()?;

        self.with_store(|db| db.touch_peer(&peer.to_string()))?;
        conn.close(0u32.into(), b"done");
        Ok(applied)
    }

    async fn accept_loop(self: Arc<Self>) {
        while let Some(incoming) = self.endpoint.accept().await {
            let node = Arc::clone(&self);
            tokio::spawn(async move {
                match incoming.await {
                    Ok(conn) => {
                        if let Err(e) = node.serve(conn).await {
                            tracing::debug!("inbound sync failed: {e:#}");
                        }
                    }
                    Err(e) => tracing::debug!("inbound connection failed: {e:#}"),
                }
            });
        }
    }

    async fn serve(&self, conn: Connection) -> Result<()> {
        let (mut send, mut recv) = conn.accept_bi().await?;
        let hello: Hello = proto::read_frame(&mut recv).await?;

        // Checked after the handshake, not before it: shutdown can land
        // while this connection is still being established, and the point
        // is that nothing merges afterwards.
        if self.closed.load(Ordering::SeqCst) {
            conn.close(2u32.into(), b"shut down");
            bail!("refused an inbound peer: this node has been shut down");
        }

        let room = self.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if !proto::room_matches(&hello.room, &room) {
            conn.close(1u32.into(), b"room mismatch");
            bail!("rejected a peer presenting the wrong room key");
        }

        let offer = Offer {
            vv: self.with_store(|db| db.version_vector())?,
            entries: self.with_store(|db| db.entries_since(&hello.vv))?,
        };
        proto::write_frame(&mut send, &offer).await?;

        let push: Push = proto::read_frame(&mut recv).await?;
        let applied = self.merge_unless_closed(&push.entries, &hello.vv)?;
        if applied > 0 {
            tracing::info!(applied, "merged updates from an inbound peer");
        }

        // An inbound peer that knows the room is a peer worth keeping,
        // so the next sync can be initiated from this side too.
        let id = conn.remote_id();
        let is_new = self
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id);
        if is_new {
            let ticket = Ticket { endpoint: id, room };
            self.with_store(|db| db.upsert_peer(&id.to_string(), &ticket.to_string(), ""))?;
        }

        send.finish()?;
        Ok(())
    }

    /// Run a store operation without holding the lock across an await.
    fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> yaiba_core::Result<T>) -> Result<T> {
        let mut db = self.store.lock().unwrap_or_else(|e| e.into_inner());
        Ok(f(&mut db)?)
    }

    /// Merge, unless this node has been shut down.
    ///
    /// The check and the merge share the store's lock, and [`shutdown`]
    /// takes that same lock to set the flag — so the two cannot interleave.
    /// Checking `closed` on its own is not enough: several awaits sit
    /// between the handshake and the merge, and a shutdown landing in that
    /// gap would still let one write through.
    ///
    /// A merge already under way when shutdown is called therefore
    /// completes, and shutdown waits for it. That is the boundary meaning
    /// "nothing lands after the close", not "nothing lands during it".
    ///
    /// [`shutdown`]: SyncNode::shutdown
    fn merge_unless_closed(
        &self,
        entries: &[yaiba_core::Entry],
        vv: &yaiba_core::VersionVector,
    ) -> Result<usize> {
        let mut db = self.store.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.load(Ordering::SeqCst) {
            bail!("refused a merge: this node has been shut down");
        }
        Ok(db.merge(entries, vv)?)
    }
}

fn generate_secret() -> SecretKey {
    SecretKey::generate()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || s.is_empty() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tickets_round_trip() {
        let ticket = Ticket {
            endpoint: generate_secret().public(),
            room: to_hex(&[0xab; 32]),
        };
        assert_eq!(ticket.to_string().parse::<Ticket>().unwrap(), ticket);
    }

    #[test]
    fn malformed_tickets_are_rejected() {
        assert!("nonsense".parse::<Ticket>().is_err());
        assert!("nonsense.zzzz".parse::<Ticket>().is_err());
    }

    #[test]
    fn hex_round_trips() {
        let bytes = [0u8, 1, 15, 16, 255];
        assert_eq!(from_hex(&to_hex(&bytes)).unwrap(), bytes);
        assert!(from_hex("abc").is_none(), "odd length");
        assert!(from_hex("").is_none());
    }
}
