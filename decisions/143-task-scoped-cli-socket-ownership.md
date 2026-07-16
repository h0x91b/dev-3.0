# Task-scoped CLI socket ownership

## Context

Desktop and headless dev3 processes share `~/.dev3.0/sockets`, but renderer-coupled CLI requests must reach the process displaying a task. Primary-first socket discovery protects self-hosted dev servers from #910/#920, yet it can send an agent completion request away from the native client that owns the task's PTY.

## Investigation

Completion request state and push subscribers are process-local, while socket modification time identifies only the newest process and a PID claim does not survive a headless restart. Broadcasting is unsafe because more than one renderer could present or resolve the same destructive approval.

## Decision

`socket-meta.ts` gives every process a logical `ownerKey`, and `socket-task-ownership.ts` stores an additive per-task claim at `sockets/task-owners/<full UUID>.json`. Successful PTY creation or restoration claims the task; claimant-PID-matched session teardown releases it; terminal task cleanup clears it before teardown and after persistence; and `resolveSocketPathForTask` prefers the live matching owner for the expanded target UUID while preserving the self-host exclusion. Explicitly port-bound headless keys survive same-endpoint restarts, while desktop and random-port headless keys remain process-scoped; completion retries only a connect-phase `APP_NOT_RUNNING` failure on a different socket.

## Risks

An interrupted in-place claim write can leave malformed JSON, which parsers deliberately ignore and normal primary-first discovery handles. Restarting a headless server on a different or random port intentionally loses logical ownership because its native client cannot reconnect to the old endpoint; a future persistent endpoint identity could preserve ownership across such reconfiguration.

## Alternatives considered

Always preferring guest sockets would reintroduce self-hosted stop/restart failures, and storing a socket PID would lose ownership on every remote restart. Renaming a temporary claim into place violates the shared `~/.dev3.0` data-layout invariant, while replaying empty responses or broadcasting completion requests risks duplicate destructive approvals.
