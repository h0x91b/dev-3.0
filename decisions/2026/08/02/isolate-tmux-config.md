# 197 — Isolate the dev3 tmux server from the user's tmux config

## Context

Since the theme-switching change (change-logs/2026/03/18), the generated dev3 tmux
config ended with three `if-shell … source-file` lines pulling in `/etc/tmux.conf`,
`~/.tmux.conf` and `~/.config/tmux/tmux.conf`. The intent was to preserve personal
keybindings inside dev3 panes. In practice it makes every dev3 terminal depend on
state we do not control: a user `set -g prefix`, `status` override, plugin manager
(`run-shell '~/.tmux/plugins/tpm/tpm'`), `mouse off`, or a smaller `history-limit`
silently changes or breaks dev3 behavior, and bug reports become unreproducible.

## Investigation

`-f` is only honored when it starts the server, and only `new-session` starts one.
`spawnAttachedSession` already passed `-f`; `newSessionDetached` (native terminal
backend, dev-server sessions) did not — so whichever of the two started the dev3
server decided whether `~/.tmux.conf` got loaded. That is a race, not a policy.

## Decision

The dev3 tmux server runs **exclusively** on the generated config.

- `TMUX_CONFIG_FUNCTIONAL` (`src/bun/tmux/config.ts`) no longer sources the system
  or user configs — the three `if-shell` lines are deleted, not made optional.
- `TmuxClient.newSessionDetached` (`src/bun/tmux/client.ts`) now prepends
  `-f activeTmuxConfigPath()`, so every server-starting path passes `-f` and tmux
  never falls back to its default config search.

## Risks

Users with personal tmux settings lose them inside dev3 panes (prefix key, plugins,
status line). That is the intended trade-off: dev3 panes are app surface, not the
user's tmux. Their own `tmux` on the default socket is untouched — dev3 has always
run on the `-L dev3` socket.

## Alternatives considered

- **Keep sourcing, add a setting.** Ships the same non-reproducible behavior with a
  switch; nobody would find it before filing the bug report.
- **`-f /dev/null` plus `source-file` of ours.** Same result, one more indirection.
- **Add `-f` everywhere in `argv()`.** tmux ignores it on a live server, so it would
  only add noise to every command's argv and to every test asserting argv.
