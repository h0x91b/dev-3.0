# Headless update safety boundaries

## Context

A headless update can restart through a detached helper or by exiting for systemd or a container supervisor. Those strategies do not have the same process-lifetime guarantee, and native terminal sessions do not expose a post-restart output timestamp.

## Investigation

The generated systemd service uses the default control-group kill behavior, so exiting the server can terminate tmux and native agent processes in the same unit before systemd starts the replacement. The download inactivity timeout also wrapped non-cancellable filesystem promises, allowing a timed-out `open` or `write` to complete after cleanup and escape the staging operation.

## Decision

`self-update-watch.ts` blocks a `supervisor-exit` apply while persisted state says an agent session is live; helper restarts may proceed because the terminal processes are detached from the server. A live native session, or a failed native liveness probe, makes terminal idleness unknown and therefore busy. The download inactivity timeout covers fetch and body reads only; local `open`, `write`, and `close` operations always settle before staging returns.

## Risks

A stale persisted runtime can delay a supervisor-owned update until startup rehydration marks the task idle. Native sessions can defer unattended updates longer than tmux sessions because their output age is unavailable, but terminating an active agent is the worse failure.

## Alternatives considered

Setting systemd `KillMode=process` would not protect container deployments and would change service cleanup semantics for every install. Adding timeouts around filesystem promises without a cancellation mechanism was rejected because returning before the operation settles leaks ownership of the file and handle.
