# 185 — An agent-initiated task launch reuses `task move` and always asks the user

## Context

Agents could already start any To Do task silently: `dev3 task move --task seq:<N> --status in-progress`
resolves the task, and `todo → in-progress` is an allowed transition (`getAllowedTransitions`,
`src/shared/types.ts`), so the lifecycle machine took the `needsActivation` branch and created a
worktree, a tmux session, and an agent — with no dialog and no way for the user to choose which agent.
The capability was wanted, the absence of control was not.

## Investigation

`prepareTask` falls back to `task.agentId`/`task.configId` when the move carries no
`preparation.launch` (`src/bun/lifecycle/executor.ts`), which is exactly what a bare CLI move does —
hence "silent launch with whatever default happened to be stored". The completion-approval flow
(`task.requestCompletion`) already had the shape we needed: register a pending request, push to the
renderer, block the CLI socket for up to 10 minutes, resolve on the user's answer. It was hardcoded to
completion.

Delivering the "you were launched by task seq:X" note turned out to be the sharp edge:
`sendMessageImmediately` throws when the task has no live agent pane, the launch is asynchronous, and
the scheduled-message scheduler **drops** an undeliverable item rather than retrying (30 s tick,
`fireScheduledMessage`). Neither path can carry a handoff into a task that is still booting.

## Decision

- **One gate, on the existing command.** `task.move` detours into approval when all of: the caller is
  an agent (`sourceTaskId` present, as `dev3 message` already sends), the target task is **not** the
  caller's own, and the move activates a non-active task. Agent status hooks (own task) and humans at a
  terminal (no `sourceTaskId`) keep the silent path. No new `task launch` command.
- **Generic request registry.** `completion-requests.ts` became `agent-requests.ts`, keyed by
  `(kind, taskId)` with kinds `complete` | `launch`; a launch decision carries the picked
  `{agentId, configId, accountId}` back to the blocked handler.
- **The pick must reach the launch.** Approval calls `launchTaskWithAgentChoice`
  (`rpc-handlers/task-lifecycle.ts`), which dispatches `moveRequested` with both a `taskPatch` and
  `preparation.launch`. A plain `moveTask` would have discarded the user's choice. It deliberately does
  **not** reuse `spawnVariants`: that stamps `groupId`/`variantIndex`, turning a solo task into a
  one-member variant group.
- **Handoff by polling, not by queue.** `agent-launch-handoff.ts` reloads the task every second for up
  to 2 minutes, waits for `!preparing && sessionState.panes.length > 0`, then sends through the
  existing cross-task envelope (which already supplies `<from-task>` and the reply command). Failure is
  a toast, never a broken launch.
- **Scratch has no prompt.** `dev3 task create --scratch --run` creates the bare placeholder, runs the
  same dialog, and **deletes the placeholder if declined** — otherwise every "no" litters To Do.
- Decline is exit code 10 (`CLI_EXIT_CODE_LAUNCH_DECLINED`).

## Risks

- The CLI must pick its socket timeout **before** it knows whether a dialog will appear, so it treats
  any unresolvable ref (`seq:N`, id prefix) as foreign and waits the long timeout. Cost of guessing
  wrong: a silent move holds the socket open a little longer, and it answers instantly anyway.
- The handoff poll is best-effort: a child whose agent pane never comes up within 2 minutes runs
  without knowing who started it (toast on the child's task).
- `task move` now has two outcomes with different response shapes. The CLI distinguishes them
  structurally (`"approved" in data`).

## Alternatives considered

- **A dedicated `dev3 task launch` command** plus rejecting cross-task activation in `task move`.
  Explicit, but two code paths for one concept, and agents would still find the `task move` hole until
  the rejection landed. Reusing `move` closes the hole with the same change that adds the feature.
- **Extending the `confirm()` service to host the agent picker.** Rejected: it turns a boolean promise
  service into a form host. The launch dialog is its own modal (`AgentLaunchRequestModal`); see
  `docs/ux/UX_DECISIONS.md` 2026-07-31.
- **`awaitCompletion: true` then send the handoff.** Still races the agent's own boot, and it would
  block the requesting agent for the whole worktree setup.
