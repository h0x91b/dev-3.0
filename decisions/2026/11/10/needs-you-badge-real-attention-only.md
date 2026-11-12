# The red badge lights only for real attention

## Context

The count badge on a task card lit for a terminal BEL and for 15 seconds of terminal silence on an in-progress task. Agents ring BEL at the end of every turn and go quiet while they think, so the badge fired for work that did not need the user and trained them to ignore it.

## Decision

The badge has these sources: `dev3 attention`, a task newly entering `user-questions`, and the show-image / show-artifact / toast-overflow signals. BEL and idle no longer push anything: the `terminalBell` push, its queue kind, the renderer listener, `setOnIdle` and the PTY idle timer are deleted.

Entering `user-questions` is the lifecycle effect `raiseQuestionsAttention` (`questionsBadgeEffects` in `src/bun/lifecycle/machine.ts`), sent through `pushCliAttention` so Focus Mode queueing and project silencing apply. It is skipped for a move the UI made (`clientPlayedSound`) and for moves that set `skipQuestionsBadge`: callers that raise their own badge with a reason (failed turns, agent exit, security hold) and the Escape-after-interrupt park (`claudeReturnedToInput`). The payload carries `kind: "questions"` and the renderer words it with `kanban.badge.waitingForAnswer`. The renderer keeps that share of the badge apart (`questionBells` in `src/mainview/state.ts`) and takes it back off when a `taskUpdated` shows the task out of `user-questions`; a questions badge still queued in Focus Mode is dropped on the same column write (`dropQueuedQuestionsAttention`, called from the `persistColumn` / `persistTerminalTask` effects). An answered question therefore leaves no "Waiting for your answer" behind, while `dev3 attention` reasons stay.

BEL still moves an in-progress task to `user-questions`, but only for agents whose hooks do not already report a tool-approval wait (`hooksReportPermissionWaits` on the adapter: Claude, Codex, omp and pi report it; Copilot's hooks never move to `user-questions` on a permission wait, Cursor's only account usage). For the reporting agents BEL can arrive before the Stop hook and park a finished turn. The agent is read from the main pane record first, because a task on the default agent keeps `agentId` null.

## Risks

- Agents on the manual skill (Gemini, Cursor, OpenCode, generic, Copilot) end every turn in `user-questions` by instruction, so they still get a badge per turn. Unchanged from before; the skill default is out of scope.
- The 15 s idle badge is gone, and BEL is ignored on the strength of the adapter, not of hooks seen live: an agent stuck on a prompt that fires no hook (Codex before rust-v0.122, which has no `PermissionRequest`; hooks that were never trusted or installed; an unhooked Claude dialog) shows neither a badge nor a column move. Gating on "a hook was seen this session" was rejected: every hooked session sends `UserPromptSubmit`, so it would not catch old Codex, and gating on a seen `PermissionRequest` would bring back the turn-end BEL race for sessions that never ask.

## Alternatives considered

Keeping BEL as a quiet count without a reason: rejected, the number alone was the noise. Putting the reason text in the backend payload: rejected, it would reach the UI untranslated.
