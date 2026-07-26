<p align="center">
  <img src="https://raw.githubusercontent.com/yukimemi/yaiba/main/assets/logo.svg" alt="yaiba — vim-flavoured todo &amp; gantt, peer to peer" width="620">
</p>

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
- **One outline, every altitude** — tasks nest, and folding to a level
  changes who the view is for: `zM` is the project list, `zR` is the
  work. A task with children becomes a summary whose dates and progress
  roll up from what is inside it.
- **Plan vs actual** — actual start and finish are stamped as work
  happens, progress is recorded per day, and `:asof 2026-07-20` shows
  the plan as it stood then. The gantt draws a progress line (イナズマ線)
  that bends left where you are behind and right where you are ahead.
- **One binary** — the web UI is compiled in.
- **Peer-to-peer** — share the ticket printed at startup; the other side
  runs `yaiba join <ticket>`, which files your tasks as a project of
  their own rather than mixing them into theirs. Edits merge through a
  field-level CRDT, so concurrent changes to the same task both survive.
  Needs outbound UDP only: no port forwarding, no inbound firewall rule.
- **Many projects** — `yaiba list`, `yaiba open <name>`, or bare
  `yaiba open` for a fuzzy picker over them.

Full documentation, keybindings and design notes:
<https://github.com/yukimemi/yaiba>

## License

MIT
