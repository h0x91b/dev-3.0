## Context

Tasks in `Preparing...` could hang for a long time with no reliable way to abort them. The expensive part spans multiple modules (`task-lifecycle`, `git`, `cow-clone`, `tmux-pty`) and each one spawns its own subprocesses through `src/bun/spawn.ts`.

## Investigation

Tracking only the top-level background promise was not enough because the actual time is spent inside child processes (`git`, `cp`, `tmux`). Adding per-call cancel plumbing to every function in the chain would have scattered task-specific state across unrelated modules.

## Decision

We track active preparation runs in `src/bun/preparation-runtime.ts` and attach task context with `AsyncLocalStorage`. `src/bun/spawn.ts` records every spawned PID when a command runs inside that context, so `cancelTaskPreparation` in `src/bun/rpc-handlers/task-lifecycle.ts` can `kill -9` the exact preparation subprocesses for one task and then revert the task to `todo`.

The registry keeps a completion barrier until the preparation function has finished and every tracked process has exited; external cancellation awaits that barrier for up to 10 seconds before continuing best-effort cleanup. Re-entrant stage-failure compensation waits only its already tracked exits so it does not deadlock the preparation that invoked it. A process spawned after cancellation remains tracked and is killed immediately instead of escaping the barrier. At startup, lifecycle recovery removes only unowned dev3 worktree registrations whose Git lock reason is exactly `initializing`; active task paths and every other locked worktree remain protected.

## Risks

This assumes preparation subprocesses are created through the shared `spawn()` wrapper. A long-running `spawnSync()` or direct `Bun.spawn()` call inside the preparing path would bypass tracking and would not be killable from the cancel action. A process that remains alive past the 10-second grace period can overlap best-effort cleanup; the bound prevents one kernel-stuck process from blocking the lifecycle indefinitely, while startup recovery handles a leftover `initializing` registration. Recovery is restricted to the managed `<task-id>/worktree` shape, the `initializing` reason, and paths not owned by active task state.

## Alternatives considered

Passing a cancellation token through every prep helper was rejected because it would touch too many modules and still would not identify which OS PIDs to kill. Killing by task worktree path alone was rejected because it is less precise and can miss processes that start before the worktree path is persisted. Waiting without a bound was rejected because an uninterruptible process could hold the task lifecycle forever; adding a persistent background-cancellation state was disproportionate to this rare fallback.
