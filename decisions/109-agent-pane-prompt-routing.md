# 109 — Route hand-off prompts by the agent-pane registry, not the active pane

## Context
Create-PR / auto-merge / rebase-conflict hand-offs type a plain-language prompt
into the task's tmux session (`sendPromptToAgentPane` in
`src/bun/rpc-handlers/git-operations.ts`). It used to always target the
session's *active* pane. When a user split off a shell or dev-server pane and
left it focused, the prompt landed there instead of the agent — issue #609.

## Investigation
`pane_current_command` cannot identify the agent pane: an agent constantly
spawns child processes, so a live Claude pane reports `zsh`/`node`/`make` at
random moments (verified on a running session). The reliable source of "which
panes run an agent" is the task's `sessionState.panes` registry — populated on
launch and every `spawnAgentInTask`, pruned on pane exit, pane IDs refreshed on
recovery.

## Decision
`resolveAgentPromptTargetPane` intersects `sessionState.panes[].paneId` with the
live pane IDs (`tmux list-panes -s`). Exactly one live agent pane → target it
unconditionally (ignore focus). Two or more → ambiguous, so respect the active
pane. Zero known agent panes (legacy tasks with no sessionState) → fall back to
the active pane, preserving old behavior.

## Risks
A manually-launched agent (user typed `claude` in a raw split, not via the app)
is not in `sessionState`, so it doesn't count — with one recorded agent pane the
prompt goes to the recorded one, not the manual one. Acceptable: the app only
knows about panes it launched.

## Alternatives considered
Match `pane_current_command` against known agent names — rejected as unreliable
(see Investigation). Always target `panes[0]` (the main pane) — rejected because
it breaks the deliberate multi-agent case where focus should decide.
