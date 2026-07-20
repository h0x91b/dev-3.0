# 144 — Detached Bun PTY owner (tmux-removal spike)

## Context

The tmux-removal roadmap (parent seq 1141) needs proof that a detached Bun
process can own a single `Bun.Terminal` shell while short-lived clients
disconnect and reattach — the persistence property tmux currently provides. This
is an isolated tracer, NOT production terminal integration and NOT a
`TerminalBackend` abstraction. Hard constraint: strictly additive, zero behavior
change to any existing tmux-backed flow, safely mergeable even if the initiative
is paused immediately after.

## Investigation

- **Bun.Terminal API** (`src/bun/prototypes/detached-pty/host.ts`):
  `Bun.spawn(argv, { terminal: { cols, rows, data } })` → `proc.terminal.write/
  resize/close`, `proc.pid`, `proc.exited`. Same primitive `pty-server.ts`
  already uses under tmux.
- **A PTY makes the shell interactive.** bash decides interactivity from
  `isatty(stdin)`, which is always true on a PTY — so even `bash --norc
  --noprofile` (no `-i`) runs interactive with **job control on**. Background
  jobs then land in their own process groups, so `kill(-shellPid)` (foreground
  group only) does NOT reap them. Robust tree-kill must walk the ppid tree
  (`collectDescendants` via one `ps -eo pid=,ppid=` snapshot) and signal each
  descendant, then the group, then the shell.
- **vitest stubs the `Bun` global** (`src/bun/test-setup.ts`) because vitest runs
  under Node — a live `Bun.Terminal` cannot run there. The targeted integration
  test therefore runs on the real Bun runtime via `bun <file>` (script
  `test:proto-e2e`), mirroring the existing `test:pane-e2e` pattern. Pure logic
  (protocol, state) stays as normal vitest unit tests.

## Decision

Self-contained prototype under `src/bun/prototypes/detached-pty/` (host,
launcher, client, protocol, state, cli, README + tests). Transport = WebSocket
over loopback TCP (`Bun.serve` on `127.0.0.1:0`) with a per-run token — works on
Windows and POSIX, gives free framing (binary = PTY bytes, text = JSON control),
mirrors the proven `dev3 remote` transport. Detached lifecycle mirrors `dev3
remote --detach`: host writes a state file as its readiness signal; the launcher
polls it then exits without killing the host; separate processes rediscover it
from that file. Metadata lives in an additive, env-overridable
`~/.dev3.0/pty-proto/` (tests use a tmpdir); `stop` kills only the prototype's
own shell tree and removes only its own files.

## Risks

- Full process-tree kill on Windows is out of scope (Bun `proc.kill()` only) —
  the POSIX ppid-walk is the tracer's proof.
- The `~/.dev3.0/pty-proto/` default path is additive; `clearState` unlinks only
  the two files it created and `rmdir`s the dir only if empty (non-recursive), so
  it can never touch other `~/.dev3.0` state or any tmux session.
- Nothing in the app/CLI graph imports the prototype, so it cannot alter existing
  behavior; removing it means deleting its directory + the one `test:proto-e2e`
  package.json line.

## Alternatives considered

- **Unix domain socket** — rejected: POSIX-only, and the roadmap targets Windows.
- **Raw loopback TCP** — rejected: needs hand-rolled framing to multiplex control
  + binary I/O; WebSocket provides it for free.
- **Group-only kill** (`kill(-shellPid)`) — rejected after observing job-control
  children escape it (orphaned `sleep` procs); replaced with the ppid-walk.
- **Integration test under vitest** — impossible: the stubbed `Bun` global has no
  real `Bun.Terminal`; a real-runtime `bun` script is the only option.
