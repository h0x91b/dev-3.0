# Boot recovery leaves a run owned by another live dev3 instance alone

## Context

Several dev3 processes share `~/.dev3.0`: the installed app, a `bun run dev` build an agent starts from a worktree, a headless `dev3 remote`. Every one runs `rehydrateTaskLifecycles()` at boot, and `bootTransition` read any `preparing` task without a live terminal as "Preparation interrupted by app restart" — then destroyed its PTY, ran the cleanup script and removed the worktree. On 2026-11-01 a dev build did exactly that to a task the installed app was creating a worktree for. The launch failed, a 308 MB non-git leftover then blocked the retry, and the requesting CLI was still told the task started.

## Decision

- `TaskRuntimeState.ownerPid` (additive; older builds ignore it) is stamped with `process.pid` on every persisted `preparing` / `tearing-down` state (`runtimeState()` and `persistPreparationStage` in `src/bun/lifecycle/executor.ts`).
- `foreignRunOwner()` (`src/bun/lifecycle/run-ownership.ts`) decides: a stamp naming a live peer with a socket in `~/.dev3.0/sockets` (`peerEndpointForPid`) → the run is that peer's; a stamp naming a dead or own pid → recover as before. **No stamp** (written by a build before this fix — the installed app in the incident) → leave it alone while ANY peer is alive (`discoverPeerSockets`).
- `rehydrateTaskLifecycles` skips `bootObserved` for such tasks and logs it; their worktree paths stay protected from stale-entry recovery.
- An agent-initiated launch (`requestAgentLaunchApproval`) now waits, up to `LAUNCH_PREPARATION_REPORT_BUDGET_MS`, for the child's persisted preparation to settle and reports it; the CLI exits `CLI_EXIT_CODE_LAUNCH_PREPARATION_FAILED` (46) on failure.

## Risks

- Unstamped runs from a crashed old instance are not recovered while some other instance is running; they recover on the next boot with no peer. Shrinks to nothing once every installed build stamps `ownerPid`.
- Pid reuse: a reused pid only counts if it also has a dev3 socket file, which `cleanupStaleSockets` removes for dead pids.
- The launch reply now arrives after preparation (seconds to minutes), so the CLI timeout grows by the same budget.

## Alternatives considered

- Heartbeat on `runtimeState.updatedAt`: fragile — a CoW clone or setup script can go minutes without a stage change.
- A single "primary instance" lock that only it may recover: larger change, and a guest build legitimately owns its own runs.
- Skipping all boot recovery whenever a peer is alive: also leaves genuinely stale stamped runs stuck; the stamp lets us be precise.
