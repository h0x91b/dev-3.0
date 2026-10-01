# Managed extra-agent launches from the CLI

## Context

The +Agent action already launches a managed agent in an existing task terminal, but coordinators had no CLI equivalent. `pane run` is a logged command execution path, not an agent launch with preset/account resolution, hooks and session tracking.

## Investigation

`SpawnAgentModal` calls `tmuxPtyHandlers.spawnAgentInTask`; `cli-socket-server.ts` has a separate explicit dispatch registry. Launch approval already carries an agent/config/account choice through `AgentLaunchRequestModal`, so adding a second picker would duplicate the same workflow.

## Decision

Expose `dev3 agent list` and `dev3 agent spawn`, using exact agent/config IDs for model-and-effort presets and the existing managed spawn handler. CLI and socket requests cannot supply an account override: the chosen harness's default account applies unless the human changes it in the approval dialog; new-task launch commands remain unchanged. Task-worktree callers use the existing approval policy and picker, without priority editing or variants. `cli-agent-spawn.ts` joins the whole operation to prevent duplicate panes and rechecks the target run; the socket dispatcher imports it only when needed.

## Risks

Extra agents share the branch and worktree, so coordinators must partition work through the initial prompt; messages target tasks, not extra panes. A timed-out CLI can leave approval pending, so its error warns against blind retries. Blocking account overrides is not a billing sandbox: custom preset credentials, provider routing and model-role bindings still take precedence under the existing launch resolver.

## Alternatives Considered

Launching arbitrary agent commands through `pane run` bypasses managed setup and session tracking. A new approval modal duplicates the existing picker and identity treatment; extra task/variant launches create separate worktrees and do not match +Agent.
