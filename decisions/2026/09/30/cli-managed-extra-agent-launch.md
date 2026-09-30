# Managed extra-agent launches from the CLI

## Context

The +Agent action already launches a managed agent in an existing task terminal, but coordinators had no CLI equivalent. `pane run` is a logged command execution path, not an agent launch with preset/account resolution, hooks and session tracking.

## Investigation

`SpawnAgentModal` calls `tmuxPtyHandlers.spawnAgentInTask`; `cli-socket-server.ts` has a separate explicit dispatch registry. Launch approval already carries an agent/config/account choice through `AgentLaunchRequestModal`, so adding a second picker would duplicate the same workflow.

## Decision

Expose `dev3 agent list` and `dev3 agent spawn`, using exact agent/config IDs and the existing managed spawn handler. Task-worktree callers go through the existing launch approval policy; the picker labels this as an extra-agent request and offers neither task priority editing nor variants. `cli-agent-spawn.ts` joins the entire pending operation to prevent one approval opening multiple panes, and rechecks the target run before spawning; the socket dispatcher imports it only when needed.

## Risks

Extra agents share the task's branch and worktree, so coordinators must partition work explicitly through the initial prompt. Messages still target a task rather than an individual extra pane; the CLI returns the pane ID for observation, not a new messaging address. A timed-out CLI can leave an approval pending, so its error warns against blind retries.

## Alternatives Considered

Launching arbitrary agent commands through `pane run` bypasses managed setup and session tracking. A new approval modal duplicates the existing picker and identity treatment; extra task/variant launches create separate worktrees and do not match +Agent.
