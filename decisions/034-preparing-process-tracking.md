## Context

Tasks in `Preparing...` could hang for a long time with no reliable way to abort them. The expensive part spans multiple modules (`task-lifecycle`, `git`, `cow-clone`, `tmux-pty`) and each one spawns its own subprocesses through `src/bun/spawn.ts`.

## Investigation

Tracking only the top-level background promise was not enough because the actual time is spent inside child processes (`git`, `cp`, `tmux`). Adding per-call cancel plumbing to every function in the chain would have scattered task-specific state across unrelated modules.

## Decision

We track active preparation runs in `src/bun/preparation-runtime.ts` and attach task context with `AsyncLocalStorage`. `src/bun/spawn.ts` records every spawned PID when a command runs inside that context, so `cancelTaskPreparation` in `src/bun/rpc-handlers/task-lifecycle.ts` can `kill -9` the exact preparation subprocesses for one task and then revert the task to `todo`.

## Risks

This assumes preparation subprocesses are created through the shared `spawn()` wrapper. A long-running `spawnSync()` or direct `Bun.spawn()` call inside the preparing path would bypass tracking and would not be killable from the new cancel action.

## Alternatives considered

Passing a cancellation token through every prep helper was rejected because it would touch too many modules and still would not identify which OS PIDs to kill. Killing by task worktree path alone was rejected because it is less precise and can miss processes that start before the worktree path is persisted.
