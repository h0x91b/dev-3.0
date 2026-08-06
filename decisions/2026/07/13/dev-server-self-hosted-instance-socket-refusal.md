# 128 — dev-server stop/restart socket refusals: guest instances must not serve their own teardown

## Context

`dev3 dev-server stop`/`restart` intermittently failed with `Empty response from
server` or a refused control socket right after a successful `start --wait`,
while `status` immediately after showed the server stopped (issues #910/#920,
~15 vents since 2026-06-19). Prior CLI-side retries (#714/#726 mitigations)
never fixed it because they replayed against the same socket.

## Investigation

dev-3.0's own devScript is `bun run dev`, which boots a **guest dev3 app
instance inside the dev-server tmux session**. That guest binds its own control
socket in `~/.dev3.0/sockets/` — the newest by mtime — so CLI discovery routed
all follow-up commands to it. A `stop`/`restart` for its host task made the
guest reap the dev session's full process tree (decision 092/099), **which
includes the guest itself**: it died before writing the RPC reply. Proof in
`~/.dev3.0/logs/2026/07/2026-07-12.log`: pid 61406 logs `→ restartDevServer` /
`→ stopDevServer` for its own host task at 12:15:22 and goes silent (no `←
done`), while the primary pid 83614 completes identical ops. A guest stopping
*another* task's session works fine. Sandbox flavor (#910): a SIGKILLed guest
leaves a stale `.sock`; under Codex seatbelt `process.kill(pid, 0)` is
EPERM-blocked, so the dead-but-newest socket stayed a "candidate" forever.

## Decision

Four layers (app + CLI), all shipped together:

1. **Socket meta sidecar** — `startSocketServer` (`src/bun/cli-socket-server.ts`)
   writes `<pid>.meta.json` with `hostTaskId = DEV3_TASK_ID ?? null` (the env
   the app injects into task/dev-server panes identifies guests, incl. headless
   `dev3 remote` started from an agent pane). Format in `src/shared/socket-meta.ts`;
   stale sidecars cleaned with stale sockets.
2. **Guest-aware discovery** — `discoverSocketIn` (`src/cli/context.ts`) sorts
   guest sockets after primaries (mtime order within groups), so control
   commands route to the primary app; also in the EPERM candidate fallback.
3. **Self-hosted teardown guard** — `stopDevServer` (`src/bun/rpc-handlers/tmux-pty.ts`)
   detects `DEV3_TASK_ID === task.id`, replies with the projected stopped state
   first and defers `killDevServerSession` by 500 ms; `restartDevServer` and
   start-over-running refuse with a clear error (a guest cannot outlive the
   teardown a restart requires).
4. **CLI instance failover** — `sendWithInstanceFailover`
   (`src/cli/commands/dev-server.ts`) re-discovers excluding the dead socket and
   replays idempotent `devServer.*` requests once against a surviving instance.

## Risks

The deferred self-hosted teardown dies mid-reap (the guest kills itself), so
SIGKILL escalation / port-release verification may not complete — the tmux
session is already gone and a replayed stop via the primary reaps leftovers,
but a brief window with orphan processes exists. Meta sidecars from crashed
instances linger until the next app startup cleans them (discovery treats a
dead pid as stale anyway). Old CLIs (≤ v1.34.0) still pick the guest by mtime,
but the app-side guard now answers them correctly.

## Alternatives considered

- **Not binding a control socket in guest instances** — breaks the dogfood loop
  (tasks created in the dev build's UI need a working CLI).
- **Guest forwards stop/restart to the primary** — the primary's teardown kills
  the forwarding guest mid-forward; the CLI still gets no reply.
- **Excluding the guest's own subtree from the reap** — leaves the dev server
  effectively running; `stop` must stop it.
- **CLI-only retries with longer windows** (prior art) — replays against the
  same dead socket; can never converge.
