# 099 — Verified dev-server teardown + port-ownership orphan sweep

## Context
Three recurring failures shared one root cause: `dev3 dev-server stop`/`restart`
returned before the devScript's process tree was actually gone. Old servers kept
serving the previous build after "restart" (agents tested stale bundles), squatted
ports made the new server crash-loop with no visible symptom, and daemonized
grandchildren survived stop as port-holding orphans.

## Investigation
Decision 092/095 already reaped the snapshotted descendant tree, but the reap was
fire-and-forget (SIGTERM → fixed 600 ms sleep → SIGKILL, no confirmation), and a
double-forked child reparented to init *before* the snapshot is invisible to any
ppid walk. Env-marker matching (`ps -E` for `DEV3_TASK_ID=`) is not viable: the
procargs sysctl is blocked for other PIDs under the packaged `.app` hardened
runtime (same class of failure as decision 095's pgrep issue). `lsof` is proven to
work there — port scanning relies on it.

## Decision
`killDevServerSession` (`src/bun/rpc-handlers/tmux-pty.ts`) now: (1) reaps via
`terminatePidsVerified` (`src/bun/process-reaper.ts`) — SIGTERM, poll for real
exit, SIGKILL survivors, poll again, report leftovers; (2) additionally sweeps
orphans by port ownership — whoever LISTENs on an assigned pool port
(`findPortHolders`, `port-scanner.ts`), is outside the live task/dev session
trees, and has `lsof -d cwd` inside the task worktree is reaped with its
descendants; anything else is reported as a foreign holder and never killed;
(3) waits for the pool ports to be released (`waitForPortsFree`) before
returning, and drops the cached port scan. `DevServerStatus` gained `devPorts`
(live ports owned by the dev session tree — the readiness signal for the new CLI
`dev-server start/restart --wait`) and `portConflicts` (assigned ports bound
outside the dev tree, printed as WARNING lines by the CLI).

## Risks
- The cwd heuristic misses orphans that `chdir` out of the worktree and spares
  foreign processes that happen to cd into it (report-only in that direction, so
  worst case is a logged warning, not a wrong kill).
- Agent-pane processes on pool ports are deliberately spared (task-session tree is
  excluded), so an agent-launched `dev3 remote` on `$DEV3_PORT0` survives stop.
- Stop can now take up to ~6.5 s in the pathological case (unkillable process +
  stuck port); typical path exits the polls in a few hundred ms.

## Alternatives considered
- **Env-marker ownership (`ps -E` / `DEV3_TASK_ID=`)** — blocked by the hardened
  runtime for other PIDs; verified empirically.
- **setsid + `kill -- -PGID`** — rejected in 092 already; misses double-forked
  daemons that create their own session.
- **Failing `start` on port conflict** — rejected: the devScript may not use the
  squatted pool port; conflicts are surfaced (log + status + CLI warning) instead.
