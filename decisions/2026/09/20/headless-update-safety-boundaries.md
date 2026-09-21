# Headless update safety boundaries

## Context

A headless update can restart through a detached helper or by exiting for systemd or a container supervisor. Those strategies do not have the same process-lifetime guarantee, and native terminal sessions do not expose a post-restart output timestamp.

## Investigation

The generated systemd service uses the default control-group kill behavior, so exiting the server can terminate tmux and native agent processes in the same unit before systemd starts the replacement. The download inactivity timeout also wrapped non-cancellable filesystem promises, allowing a timed-out `open` or `write` to complete after cleanup and escape the staging operation.

## Decision

`self-update-watch.ts` blocks a `supervisor-exit` apply while an agent session is live; helper restarts may proceed because the terminal processes are detached from the server. Liveness is read from `runtimeState` on a task that has a worktree and sits in an active column, and `preparing` counts as live because a restart landing mid-worktree-creation is the messiest case. `runtimeState` is an additive field an older build may never have written, so an absent one is unknown rather than live and the task's own backend is probed (`tmuxSessionExists` or `nativeTaskPanesAlive`); a task whose `terminalBackend` field cannot be decoded counts as live instead of throwing the tick away. A live native session, or a failed native liveness probe, makes terminal idleness unknown and therefore busy. The download inactivity timeout covers fetch and body reads only; local `open`, `write`, and `close` operations always settle before staging returns.

## Risks

The gate sits in front of the quiet window, so the 72-hour ceiling cannot release it — a genuinely live agent defers an unattended supervisor-owned update indefinitely, which is the intended trade. That is why the live set is kept to tasks that really can have a process: a never-launched task or a stale record must not pin a box on an old build. Native sessions can defer unattended updates longer than tmux sessions because their output age is unavailable, but terminating an active agent is the worse failure.

## Alternatives considered

Setting systemd `KillMode=process` would not protect container deployments and would change service cleanup semantics for every install. Adding timeouts around filesystem promises without a cancellation mechanism was rejected because returning before the operation settles leaks ownership of the file and handle.
