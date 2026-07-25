# yaiba

> 刃 — *the blade*. A vim-flavoured todo and gantt planner that runs as a
> single local binary and syncs directly between people. No server to
> host, no account to make.

```sh
cargo install yaiba
yaiba
```

The UI opens at `http://localhost:8188`. Press `?` for keys.

- **The keyboard is the interface** — modal editing, `:` commands,
  operators that wait for a motion. `o` opens a row and you type, `x`
  completes it, `dd` deletes and `u` brings it back.
- **Dependencies are real** — finish-to-start edges feed a
  forward/backward pass that computes earliest start, slack, and the
  critical path.
- **One binary** — the web UI is compiled in.
- **Peer-to-peer** — share the ticket printed at startup; the other side
  runs `yaiba --join <ticket>`. Edits merge through a field-level CRDT,
  so concurrent changes to the same task both survive. Needs outbound
  UDP only: no port forwarding, no inbound firewall rule.

Full documentation, keybindings and design notes:
<https://github.com/yukimemi/yaiba>

## License

MIT
