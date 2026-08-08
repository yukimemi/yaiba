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

mod gate;
pub mod proto;

use std::collections::HashSet;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use iroh::endpoint::{Connection, PortmapperConfig};
use iroh::tls::CaTlsConfig;
use iroh::{Endpoint, EndpointId, SecretKey};
use tokio::sync::Notify;
use yaiba_core::Store;

use crate::gate::Gate;
use crate::proto::{Hello, Offer, Push};

const ALPN: &[u8] = b"yaiba/sync/1";

/// How often to reach out to known peers even when nothing changed
/// locally — catches writes made while this replica was offline.
const IDLE_SYNC: Duration = Duration::from_secs(30);

/// How long one exchange with one peer may run before it is abandoned.
///
/// `sync_all` walks its peers in sequence and `POST /api/peers` awaits it
/// directly, so an exchange with no ceiling is not one stalled pairing —
/// it is every pairing, plus an HTTP request that never answers. Only the
/// startup pull was bounded (`FIRST_SYNC`, in the binary), and that is
/// already the call that treats an unresponsive peer as "try again on the
/// next tick" rather than as something to wait out.
///
/// The QUIC idle timeout is not this bound and cannot be: a peer whose
/// endpoint driver still answers while its application is wedged —
/// blocked on a slow store write inside `merge`, say — keeps the
/// connection healthy while never writing the frame we are waiting for.
///
/// Generous on purpose. A full dataset is well under a megabyte of JSON
/// (see [`proto`]), so an exchange anywhere near this is a peer that has
/// stopped answering rather than a slow one. Abandoning it costs a delay
/// and never data: the driver retries every [`IDLE_SYNC`] and a CRDT
/// exchange is idempotent.
#[cfg(not(test))]
const EXCHANGE: Duration = Duration::from_secs(60);
/// Short enough to assert against. What is under test is that the bound
/// exists and reports rather than hangs, which does not depend on its
/// length; loopback exchanges finish in well under a millisecond.
#[cfg(test)]
const EXCHANGE: Duration = Duration::from_millis(500);

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
    gate: Gate,
    /// Hex room key. Replaced when joining someone else's group.
    room: Mutex<String>,
    peers: Mutex<HashSet<EndpointId>>,
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
        let (secret, room) = Self::identity(&store)?;

        // Reading the store is file / registry / keychain I/O, and one
        // process holds every project, so this runs once per project on
        // whatever worker thread `start_with` landed on. Off the runtime
        // it cannot stall anything else, however slow the store is —
        // `SSL_CERT_DIR` can point at a network mount.
        let roots = tokio::task::spawn_blocking(ca_tls_config)
            .await
            .context("reading the system certificate store failed")?;

        let mut builder = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret)
            .ca_tls_config(roots)
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

        Self::serve_on(endpoint, store, room)
    }

    /// The persisted half of a node's identity — the endpoint secret and
    /// the room it belongs to — both minted on first use.
    fn identity(store: &Arc<Mutex<Store>>) -> Result<(SecretKey, String)> {
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
        Ok((secret, room))
    }

    /// Take an already-bound endpoint and start serving on it.
    ///
    /// Split out of [`SyncNode::start_with`] for the tests, which bind
    /// loopback only. Binding the way production does puts a firewall
    /// prompt between the test and its assertion on any machine that has
    /// not already answered one — and the prompt wants an administrator,
    /// which is precisely the machine [`Transport::RelayOnly`] exists
    /// for. What is under test is the exchange, and the exchange cannot
    /// tell which interface carried it.
    fn serve_on(endpoint: Endpoint, store: Arc<Mutex<Store>>, room: String) -> Result<Arc<Self>> {
        let node = Arc::new(Self {
            endpoint,
            gate: Gate::new(store),
            room: Mutex::new(room),
            peers: Mutex::new(HashSet::new()),
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
        // First, and under the store lock: a merge already running
        // finishes and this waits for it; none can start afterwards.
        self.gate.close();
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
        self.gate.with_store(|db| {
            db.set_meta(META_ROOM, &ticket.room)?;
            db.upsert_peer(&ticket.endpoint.to_string(), &ticket.to_string(), "")
        })?;
        *self.room.lock().unwrap_or_else(|e| e.into_inner()) = ticket.room.clone();
        self.peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(ticket.endpoint);
        Ok(())
    }

    fn load_peers(&self) -> Result<()> {
        let stored = self.gate.with_store(|db| db.list_peers())?;
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
    ///
    /// Bounded by [`EXCHANGE`], because [`SyncNode::sync_all`] walks its
    /// peers in sequence: an exchange that never returns does not stall
    /// one pairing, it stalls every one of them.
    pub async fn sync_with(&self, peer: EndpointId) -> Result<usize> {
        tokio::time::timeout(EXCHANGE, self.exchange(peer))
            .await
            .with_context(|| format!("gave up on {peer} after {}s", EXCHANGE.as_secs_f32()))?
    }

    async fn exchange(&self, peer: EndpointId) -> Result<usize> {
        let conn = self
            .endpoint
            .connect(peer, ALPN)
            .await
            .with_context(|| format!("could not reach {peer}"))?;
        let (mut send, mut recv) = conn.open_bi().await?;

        let hello = Hello {
            room: self.room.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            vv: self.gate.with_store(|db| db.version_vector())?,
        };
        proto::write_frame(&mut send, &hello).await?;

        let offer: Offer = proto::read_frame(&mut recv).await?;
        let applied = self.gate.merge(&offer.entries, &offer.vv)?;

        // Now that their vector is known, send back only what they lack.
        let entries = self.gate.with_store(|db| db.entries_since(&offer.vv))?;
        proto::write_frame(&mut send, &Push { entries }).await?;
        send.finish()?;

        // Wait for *their* end of the stream before tearing the connection
        // down, and note that `finish` above is not that wait: it says only
        // that this side will write no more. Closing straight after it sent
        // a CONNECTION_CLOSE that raced the push down the wire, and a peer
        // still reassembling a stream is entitled to drop it when that
        // frame lands — so the offer above always arrived and the push
        // never did. Sync was silently one-way for every replica that
        // dialled, in the direction nobody checks, and the 30s retry
        // reproduced it rather than repairing it.
        //
        // `serve` finishes its send stream only after merging the push, so
        // a clean EOF here is proof it got that far. `stopped()` is the
        // narrower guarantee — bytes acknowledged, not bytes acted on —
        // and an explicit ack frame would be a wire change; this is
        // neither, and it reads the same on both sides of an upgrade
        // because `serve` already finished exactly here.
        recv.read_to_end(0)
            .await
            .context("peer hung up before it accepted the push")?;

        self.gate
            .with_store(|db| db.touch_peer(&peer.to_string()))?;
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
        if self.gate.is_closed() {
            conn.close(2u32.into(), b"shut down");
            bail!("refused an inbound peer: this node has been shut down");
        }

        let room = self.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if !proto::room_matches(&hello.room, &room) {
            conn.close(1u32.into(), b"room mismatch");
            bail!("rejected a peer presenting the wrong room key");
        }

        // An inbound peer that knows the room is a peer worth keeping, so
        // the next sync can be initiated from this side too — and it is
        // filed *before* a single entry is handed over, not after the
        // exchange completes. The room key is the whole of the
        // authorisation and they have just presented it, so by here there
        // is nothing left to learn about them; `remote_id` is known from
        // the connection itself.
        //
        // Registering at the end instead made every failure in the tail
        // asymmetric in the worst direction: this replica had already
        // given away its entire dataset to a peer it kept no record of,
        // and with no record it never dials back, so the pairing stayed
        // one-way for good. Filing them here means the driver's next tick
        // reaches them from this side and the exchange repairs itself,
        // whatever went wrong downstream.
        let id = conn.remote_id();
        let is_new = self
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id);
        if is_new {
            let ticket = Ticket { endpoint: id, room };
            self.gate
                .with_store(|db| db.upsert_peer(&id.to_string(), &ticket.to_string(), ""))?;
        }

        let offer = Offer {
            vv: self.gate.with_store(|db| db.version_vector())?,
            entries: self.gate.with_store(|db| db.entries_since(&hello.vv))?,
        };
        proto::write_frame(&mut send, &offer).await?;

        let push: Push = match proto::read_frame(&mut recv).await {
            Ok(push) => push,
            Err(e) => {
                // Loud, where the rest of the inbound path is quiet. A
                // peer that showed the room and took the offer and then
                // failed to deliver its own half is the one inbound
                // failure that costs something, and at `debug!` with the
                // rest it hid a one-way sync for as long as it took
                // somebody to notice their edits were not arriving.
                tracing::warn!(%id, "an inbound peer's push did not arrive: {e:#}");
                return Err(e);
            }
        };
        let applied = self.gate.merge(&push.entries, &hello.vv)?;
        if applied > 0 {
            tracing::info!(applied, "merged updates from an inbound peer");
        }

        send.finish()?;
        // The same door-slam as the dialler's, from the other side and
        // one frame later: returning drops `conn`, dropping it closes the
        // connection with code 0, and that raced the FIN just finished
        // above — the FIN being the dialler's only evidence that the push
        // was merged. It cost nothing while nobody waited for it and
        // broke every exchange the moment somebody did.
        //
        // `stopped()` rather than the dialler's read-to-EOF because the
        // two need different things: it has to know the push was *acted
        // on*, this only has to know its own bytes got out.
        let _ = send.stopped().await;
        Ok(())
    }
}

/// Trust anchors for the TLS iroh speaks to *external* services —
/// relays, pkarr, DNS-over-HTTPS.
///
/// iroh trusts a compiled-in copy of the Mozilla root list and nothing
/// else, and no environment variable can widen it: `webpki-roots` reads
/// neither `SSL_CERT_FILE` nor `SSL_CERT_DIR`, so a shipped binary has
/// no way out from the outside. On a machine behind a TLS-inspecting
/// proxy the interception CA sits in the OS store, where every browser
/// and every other tool on the box finds it, and is invisible to iroh —
/// so every relay probe fails `UnknownIssuer`, and with it the relay
/// connection and the discovery lookups. Relay-only sync, the mode a
/// locked-down machine is told to use, cannot connect at all.
///
/// This does not widen what a *peer* can claim to be: iroh authenticates
/// its own connections by key and never consults these roots.
///
/// **Not `CaTlsConfig::system()`.** iroh's `platform-verifier` feature
/// would be the obvious answer, and on Windows it breaks every relay:
/// the default relay hostnames are absolute — `aps1-1.relay.n0.iroh.link.`,
/// trailing dot — and `rustls-platform-verifier` hands that name to
/// CryptoAPI verbatim, which matches it against the certificate's
/// dot-less SAN and reports `NotValidForName`. webpki folds the root
/// label away and accepts it. So the roots come from the OS while the
/// matching stays webpki's.
///
/// The embedded roots stay in the store underneath. Dropping them would
/// mean a host with no CA bundle at all — a bare container — has nothing
/// to verify with, and that is `bind()` failing, which for the active
/// project is the server refusing to start.
fn ca_tls_config() -> CaTlsConfig {
    ca_tls_config_from(rustls_native_certs::load_native_certs())
}

/// The half of [`ca_tls_config`] that does not touch the machine, so a
/// test can hand it a root of its own.
fn ca_tls_config_from(found: rustls_native_certs::CertificateResult) -> CaTlsConfig {
    for e in &found.errors {
        tracing::warn!("could not read part of the system certificate store: {e}");
    }
    tracing::debug!(
        count = found.certs.len(),
        "loaded CA roots from the system store"
    );
    CaTlsConfig::embedded().with_extra_roots(found.certs)
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
    use std::time::{SystemTime, UNIX_EPOCH};

    use iroh::EndpointAddr;
    use iroh::address_lookup::MemoryLookup;
    use rustls_pki_types::{ServerName, UnixTime};
    use yaiba_core::NewTask;

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

    /// Whatever the machine's own store holds — a full corporate root
    /// list, a broken entry, nothing at all — the config still has to
    /// build a verifier. The one that doesn't is `bind()` returning
    /// `InvalidCaRootConfig`, which for the active project is the server
    /// refusing to start.
    #[test]
    fn a_trust_store_is_always_produced() {
        assert!(
            ca_tls_config()
                .server_cert_verifier(iroh::tls::default_provider())
                .is_ok()
        );
    }

    /// The point of the whole thing: a certificate signed by a root the
    /// Mozilla list has never heard of — a TLS-inspecting proxy's CA —
    /// verifies once the machine's store carries it, and does not
    /// before. Checked at the absolute hostname form iroh uses for every
    /// default relay, which is what rules the platform verifier out.
    #[test]
    fn a_root_from_the_store_is_what_makes_its_certificates_verify() {
        let mut ca_params = rcgen::CertificateParams::new(Vec::new()).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        ca_params
            .key_usages
            .push(rcgen::KeyUsagePurpose::KeyCertSign);
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let issuer = rcgen::Issuer::new(ca_params.clone(), &ca_key);
        let ca = ca_params.self_signed(&ca_key).unwrap();

        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let leaf = rcgen::CertificateParams::new(vec!["relay.example.com".to_string()])
            .unwrap()
            .signed_by(&leaf_key, &issuer)
            .unwrap();

        let mut found = rustls_native_certs::CertificateResult::default();
        found.certs.push(ca.der().clone());

        let verify = |config: CaTlsConfig| {
            let verifier = config
                .server_cert_verifier(iroh::tls::default_provider())
                .unwrap();
            // The trailing dot is iroh's, not a typo: `CryptoAPI` fails
            // this name against the dot-less SAN, webpki accepts it.
            let name = ServerName::try_from("relay.example.com.").unwrap();
            let now =
                UnixTime::since_unix_epoch(SystemTime::now().duration_since(UNIX_EPOCH).unwrap());
            verifier
                .verify_server_cert(leaf.der(), &[], &name, &[], now)
                .is_ok()
        };

        assert!(
            !verify(CaTlsConfig::embedded()),
            "the embedded roots alone must not know this CA — otherwise \
             the assertion below proves nothing"
        );
        assert!(
            verify(ca_tls_config_from(found)),
            "a root the machine trusts has to reach the verifier"
        );
    }

    #[test]
    fn hex_round_trips() {
        let bytes = [0u8, 1, 15, 16, 255];
        assert_eq!(from_hex(&to_hex(&bytes)).unwrap(), bytes);
        assert!(from_hex("abc").is_none(), "odd length");
        assert!(from_hex("").is_none());
    }

    /// A replica on loopback, sharing one in-memory address book with
    /// the others in its test.
    ///
    /// Everything that would reach the network is off — no relay, no
    /// discovery, and `clear_ip_transports` before an explicit
    /// `127.0.0.1:0` so the only socket is a loopback one. That keeps
    /// these tests off CI's network *and* away from the firewall prompt
    /// that binding `0.0.0.0` raises, which on the machine this bug was
    /// found on cannot be answered at all. None of it is visible to the
    /// exchange under test: it reads and writes streams and never learns
    /// which interface carried them.
    async fn loopback_endpoint(lookup: &MemoryLookup, secret: SecretKey) -> Endpoint {
        // `Minimal` is the preset that sets nothing but the crypto
        // provider — no relay, no discovery — where `N0` is the one
        // production uses and would reach n0's DNS and relays.
        let endpoint = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .ca_tls_config(ca_tls_config())
            .address_lookup(lookup.clone())
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0")
            .unwrap()
            .bind()
            .await
            .unwrap();

        // Dialling goes by `EndpointId` alone, so the address has to be
        // in the book before anyone looks it up.
        lookup.add_endpoint_info(
            EndpointAddr::new(endpoint.id()).with_ip_addr(endpoint.bound_sockets()[0]),
        );
        endpoint
    }

    async fn loopback_node(lookup: &MemoryLookup) -> (Arc<SyncNode>, Arc<Mutex<Store>>) {
        let store = Arc::new(Mutex::new(Store::open_in_memory().unwrap()));
        let (secret, room) = SyncNode::identity(&store).unwrap();
        let endpoint = loopback_endpoint(lookup, secret).await;
        let node = SyncNode::serve_on(endpoint, Arc::clone(&store), room).unwrap();
        (node, store)
    }

    fn task_titled(store: &Arc<Mutex<Store>>, title: &str) -> yaiba_core::TaskId {
        store
            .lock()
            .unwrap()
            .create_task(NewTask {
                title: title.into(),
                ..Default::default()
            })
            .unwrap()
            .id
    }

    /// The regression this module's loopback machinery exists for.
    ///
    /// A dialling replica used to finish its push and close the
    /// connection in the next breath, which put a CONNECTION_CLOSE in a
    /// race with the push it had just written — and a peer still
    /// reassembling a stream may drop it when that frame lands. So the
    /// offer always arrived and the push never did: sync looked healthy
    /// from the dialler's side, where the other replica's edits kept
    /// turning up, and moved nothing in the other direction.
    ///
    /// Asserted both ways from one exchange, because *one direction
    /// working* is precisely what the bug looked like. No sleep and no
    /// polling: `serve` finishes its stream only after merging the push,
    /// so `sync_with` returning is itself the proof it landed.
    #[tokio::test]
    async fn one_exchange_moves_tasks_in_both_directions() {
        let lookup = MemoryLookup::new();
        let (host, host_store) = loopback_node(&lookup).await;
        let (joiner, joiner_store) = loopback_node(&lookup).await;

        let theirs = task_titled(&host_store, "theirs");
        let mine = task_titled(&joiner_store, "mine");

        joiner.join(&host.ticket()).unwrap();
        joiner.sync_with(host.endpoint.id()).await.unwrap();

        assert_eq!(
            joiner_store.lock().unwrap().get_task(theirs).unwrap().title,
            "theirs",
            "the offer is the direction that never broke"
        );
        assert_eq!(
            host_store.lock().unwrap().get_task(mine).unwrap().title,
            "mine",
            "the push is the direction that was being dropped"
        );
    }

    /// The listener files a peer before it hands over a single entry.
    ///
    /// Filing it at the end of the exchange instead meant any failure in
    /// the tail left this side having given away its whole dataset to a
    /// peer it kept no record of — and with no record it never dials
    /// back, so one lost frame became a permanently one-way pairing
    /// rather than something the next tick repaired. Checked in the
    /// store as well as in memory, since dialling back after a restart
    /// is the half that matters.
    #[tokio::test]
    async fn the_listener_files_a_peer_it_has_served() {
        let lookup = MemoryLookup::new();
        let (host, host_store) = loopback_node(&lookup).await;
        let (joiner, _joiner_store) = loopback_node(&lookup).await;

        joiner.join(&host.ticket()).unwrap();
        joiner.sync_with(host.endpoint.id()).await.unwrap();

        let dialler = joiner.endpoint.id();
        assert!(
            host.peer_ids().contains(&dialler),
            "the listener has to be able to start the next exchange itself"
        );
        assert!(
            host_store
                .lock()
                .unwrap()
                .list_peers()
                .unwrap()
                .iter()
                .any(|(node, _, _)| node == &dialler.to_string()),
            "and to still know them after a restart"
        );
    }

    /// The half of the registration order that the happy path cannot
    /// show: a dialler that takes the offer and then vanishes is still
    /// filed as a peer.
    ///
    /// This is the listener's view of the bug above — the exchange dying
    /// after the offer went out and before the push came back. Filed at
    /// the end of the exchange, this replica finished having handed over
    /// its whole dataset with no idea who to, and no way to ever start
    /// an exchange with them; filed up front, the driver's next tick
    /// reaches them and it repairs itself.
    ///
    /// No sleep: the registration happens before the offer is written,
    /// so having read the offer *is* the proof it already happened.
    #[tokio::test]
    async fn a_dialler_that_vanishes_mid_exchange_is_still_filed() {
        let lookup = MemoryLookup::new();
        let (host, _host_store) = loopback_node(&lookup).await;

        let secret = generate_secret();
        let rogue = secret.public();
        let endpoint = loopback_endpoint(&lookup, secret).await;
        let conn = endpoint.connect(host.endpoint.id(), ALPN).await.unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();

        let hello = Hello {
            room: host.ticket().room,
            vv: yaiba_core::VersionVector::new(),
        };
        proto::write_frame(&mut send, &hello).await.unwrap();
        let _offer: Offer = proto::read_frame(&mut recv).await.unwrap();
        conn.close(0u32.into(), b"vanished");

        assert!(
            host.peer_ids().contains(&rogue),
            "a peer that was handed the offer has to be one this side can dial back"
        );
    }

    /// A peer that stops answering must not take the others down with
    /// it.
    ///
    /// `sync_all` walks its peers in sequence and the join handler
    /// awaits it, so an exchange with no ceiling stalls every pairing and
    /// hangs an HTTP request besides. The QUIC idle timeout cannot stand
    /// in for the ceiling: the connection here is perfectly healthy, and
    /// that is the point — it is the shape of a listener wedged inside
    /// `merge`, answering at the transport layer while never writing the
    /// frame this side is waiting for.
    #[tokio::test]
    async fn an_exchange_with_a_silent_peer_is_abandoned() {
        let lookup = MemoryLookup::new();
        let (dialler, _store) = loopback_node(&lookup).await;

        let secret = generate_secret();
        let silent_id = secret.public();
        let silent = loopback_endpoint(&lookup, secret).await;
        tokio::spawn(async move {
            while let Some(incoming) = silent.accept().await {
                let Ok(conn) = incoming.await else { continue };
                // Take the stream, then answer nothing on it, ever.
                let _held = conn.accept_bi().await;
                std::future::pending::<()>().await;
            }
        });

        let err = dialler.sync_with(silent_id).await.unwrap_err();
        assert!(
            format!("{err:#}").contains("gave up on"),
            "the exchange has to report rather than hang, got: {err:#}"
        );
    }

    /// `join` fails locally or not at all — it never waits on a peer.
    ///
    /// This is the premise its callers rest on. `POST /api/projects/join`
    /// treats a failure here as fatal and unwinds the project it has just
    /// created, while letting the *pull* that follows fail quietly, on
    /// the grounds that only the pull can fail because somebody's laptop
    /// is shut. If this ever became infallible, or started tolerating a
    /// self-ticket, that refusal would quietly become unreachable.
    #[tokio::test]
    async fn joining_your_own_ticket_is_refused_and_changes_nothing() {
        let lookup = MemoryLookup::new();
        let (node, _store) = loopback_node(&lookup).await;

        let before = node.ticket().room;
        assert!(node.join(&node.ticket()).is_err());
        assert_eq!(
            node.ticket().room,
            before,
            "a refused join must not have moved the room key"
        );
        assert!(
            node.peer_ids().is_empty(),
            "nor filed the replica as its own peer"
        );
    }

    /// Moving the registration earlier must not move it past the only
    /// authorisation the protocol has. A peer that cannot present the
    /// room key is refused, and leaves nothing behind to dial.
    #[tokio::test]
    async fn a_stranger_is_refused_and_filed_nowhere() {
        let lookup = MemoryLookup::new();
        let (host, _host_store) = loopback_node(&lookup).await;
        // No `join`, so the two rooms are the unrelated keys each store
        // minted for itself.
        let (stranger, _stranger_store) = loopback_node(&lookup).await;

        assert!(
            stranger.sync_with(host.endpoint.id()).await.is_err(),
            "a room mismatch has to fail the exchange"
        );
        assert!(
            host.peer_ids().is_empty(),
            "and must not leave the stranger filed as a peer"
        );
    }
}
