//! Peer-to-peer replication over iroh.
//!
//! Every `yaiba` instance is a full replica. Syncing is symmetric — no
//! peer is authoritative and none has to be reachable at a fixed
//! address. iroh dials by public key and hole-punches, so peers need
//! outbound UDP and nothing else: no port forwarding, no inbound rule.
//! When hole punching fails the connection falls back to a relay, which
//! only forwards already-encrypted QUIC and cannot read the contents.
//!
//! Membership is a shared 32-byte *room key*, handed around inside a
//! ticket. A peer that can't present it is dropped before any data
//! moves.

pub mod proto;

use std::collections::HashSet;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use iroh::endpoint::Connection;
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

pub struct SyncNode {
    endpoint: Endpoint,
    store: Arc<Mutex<Store>>,
    /// Hex room key. Replaced when joining someone else's group.
    room: Mutex<String>,
    peers: Mutex<HashSet<EndpointId>>,
}

impl SyncNode {
    /// Bind an endpoint and start serving. Identity is persisted, so a
    /// restart rejoins as the same peer with the same ticket.
    pub async fn start(store: Arc<Mutex<Store>>) -> Result<Arc<Self>> {
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

        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .context("failed to bind the iroh endpoint")?;

        let node = Arc::new(Self {
            endpoint,
            store,
            room: Mutex::new(room),
            peers: Mutex::new(HashSet::new()),
        });

        node.load_peers()?;

        let listener = Arc::clone(&node);
        tokio::spawn(async move { listener.accept_loop().await });

        Ok(node)
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
        let applied = self.with_store(|db| db.merge(&offer.entries, &offer.vv))?;

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
        let applied = self.with_store(|db| db.merge(&push.entries, &hello.vv))?;
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
