# 123 — Graceful dev-server status on tmux launch failure

## Context

`dev3 dev-server status` (and `restart`) could hard-crash with a raw
`error: ENOENT: no such file or directory, posix_spawn '/opt/homebrew/bin/tmux'`
even though the binary resolved fine from a normal shell. Root cause is almost
always **macOS Full Disk Access lost** mid-session: sandboxed worktree processes
then can't reach the tmux binary (or `.git`) though the exact path exists. A
read-only status query should never crash on that — it should degrade and point
at the fix.

## Investigation

The CLI sends `devServer.status` over the socket; the app runs the tmux work.
`Bun.spawn` throws SYNCHRONOUSLY when the resolved path can't be executed. In
the status path the port-scanner helpers already swallow spawn failures
(`runText` returns `""`), so the only throwing tmux call is `isDevServerRunning`
(the first, gating call in `buildDevServerStatus`). Its raw error propagated out
of `getDevServerStatus` → RPC → CLI printed `error: <raw ENOENT>` and exited.

## Decision

Error-handling + diagnostics only (no PATH/spawn rewrite):

1. `spawnTmux()` / `TmuxSpawnError` / `isTmuxSpawnError` in `src/bun/pty-server.ts`
   wrap a tmux spawn and translate a launch-time failure into a typed error whose
   message names the binary, preserves the raw cause, and points at the FDA fix.
2. `isDevServerRunning` + `findDevServerViewerPaneId` (`src/bun/rpc-handlers/tmux-pty.ts`)
   spawn via `spawnTmux`. `buildDevServerStatus` catches `TmuxSpawnError` and
   returns a **degraded** status: tmux-free facts kept (assignedPorts, worktree,
   session names), live fields empty, diagnostic carried in the new optional
   `DevServerStatus.tmuxError`. Non-tmux errors still propagate.
3. The CLI (`src/cli/commands/dev-server.ts`) renders `State: unknown (tmux
   unavailable)` + a `WARNING:` line and exits 0 for status. `start`/`restart`
   still call `isDevServerRunning` early, so they surface the clear message as a
   normal error (you genuinely can't operate without tmux).

## Risks

- `status` now exits 0 when tmux is unreachable — a script checking only the exit
  code sees success. Mitigated by a prominent `WARNING:` and an explicit
  "unknown" state; graceful-not-crashing was the explicit ask.
- `tmuxError` is additive/optional on `DevServerStatus` — older backends never
  send it, older CLIs ignore it, so the frozen `~/.dev3.0/` layout is untouched.

## Alternatives considered

- Route all ~100 tmux spawns through `spawnTmux` — a rewrite the maintainer
  explicitly scoped out; the status path needed only the gating call.
- Persist last-known dev-server state to disk — over-engineered; the in-memory
  port pool already provides the only meaningful tmux-free "last-known" fields.
