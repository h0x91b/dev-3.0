# Headless updates survive running agents

## Context

The headless updater treated every `in-progress` task as a hard restart blocker, unlike the desktop updater. Long-running tasks could therefore prevent a ready canary update from applying indefinitely even though their tmux sessions survive a server restart.

## Investigation

The existing self-update decision already rejected gating restarts on running agents because task status is a coarse signal and tmux preserves the agent process. Headless mode retained a separate gate despite using the same stale-worktree recovery and handoff mechanisms as manual and desktop restarts.

## Decision

`evaluateQuietWindow` considers only browser clients and recent terminal output; active tasks remain a warning but never block a headless update. The 72-hour ceiling still removes those remaining quiet-window delays, while the restart handoff preserves the remote route and surviving tmux sessions.

## Risks

A restart can occur while a task is preparing its worktree, just as it can during a manual or desktop restart. Existing stale-worktree recovery handles that interrupted state, and the agent process remains alive in tmux.

## Alternatives considered

Gating only `preparing` tasks would narrow the indefinite block but preserve an unexplained difference between headless and desktop behavior. Keeping the full active-task gate was rejected because it makes unattended canary updates unreliable by design.
