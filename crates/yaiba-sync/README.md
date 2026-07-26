<p align="center">
  <img src="https://raw.githubusercontent.com/yukimemi/yaiba/main/assets/logo.svg" alt="yaiba — vim-flavoured todo &amp; gantt, peer to peer" width="620">
</p>

# yaiba-sync

Peer-to-peer replication for [yaiba](https://github.com/yukimemi/yaiba)
over [iroh](https://iroh.computer) QUIC — no server in the middle.

This is the transport, not the app. Install
[`yaiba`](https://crates.io/crates/yaiba) if you want the tool.

## How it works

Every instance is a full replica and syncing is symmetric: no peer is
authoritative, and none has to be reachable at a fixed address. iroh
dials by public key and hole-punches, so peers need **outbound UDP and
nothing else** — no port forwarding, no inbound firewall rule. When hole
punching fails the connection falls back to a relay, which forwards
already-encrypted QUIC and cannot read what passes through.

Hole punching binds a UDP socket on every interface, which is what a
desktop firewall asks about on startup. `SyncNode::start_with` and
`Transport::RelayOnly` bind no UDP socket at all and let the relay carry
everything — slower, but there is no prompt to answer, and on a machine
without administrator rights there is nobody who could answer it.

One bidirectional stream carries a three-message exchange that leaves
both sides holding the union of each other's writes:

```text
  dialer  ──── Hello { room, vv_a } ────▶  listener
          ◀─── Offer { vv_b, entries } ──          (what A is missing)
          ──── Push  { entries } ───────▶          (what B is missing)
```

Both directions travel in a single round trip because each side sends
its version vector before the other has to decide what to transmit —
only the difference crosses the wire, never the whole dataset.

Membership is a shared 32-byte room key carried in the ticket. A peer
that can't present it is dropped before any data moves.

## License

MIT
