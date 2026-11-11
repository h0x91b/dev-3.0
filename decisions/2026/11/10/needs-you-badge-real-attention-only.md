# The red badge lights only for real attention

## Context

The count badge on a task card lit for a terminal BEL and for 15 seconds of terminal silence on an in-progress task. Agents ring BEL at the end of every turn and go quiet while they think, so the badge fired for work that did not need the user and trained them to ignore it.

## Decision

The badge has these sources: `dev3 attention`, a task newly entering `user-questions`, and the show-image / show-artifact / toast-overflow signals. BEL and idle no longer push anything: the `terminalBell` push, its queue kind, the renderer listener, `setOnIdle` and the PTY idle timer are deleted.

Entering `user-questions` is the lifecycle effect `raiseQuestionsAttention` (`questionsBadgeEffects` in `src/bun/lifecycle/machine.ts`), sent through `pushCliAttention` so Focus Mode queueing and project silencing apply. It is skipped for a move the UI made (`clientPlayedSound`) and for moves that set `skipQuestionsBadge`: callers that raise their own badge with a reason (failed turns, agent exit, security hold) and the Escape-after-interrupt park (`claudeReturnedToInput`). The payload carries `kind: "questions"` and the renderer words it with `kanban.badge.waitingForAnswer`.

BEL still moves an in-progress task to `user-questions`, but only for agents whose hooks do not already report a tool-approval wait (`hooksReportPermissionWaits` on the adapter: Claude, Codex, omp and pi report it; Copilot's hooks never move to `user-questions` on a permission wait, Cursor's only account usage). For the reporting agents BEL can arrive before the Stop hook and park a finished turn. The agent is read from the main pane record first, because a task on the default agent keeps `agentId` null.

## Risks

- Agents on the manual skill (Gemini, Cursor, OpenCode, generic, Copilot) end every turn in `user-questions` by instruction, so they still get a badge per turn. Unchanged from before; the skill default is out of scope.
- The 15 s idle badge is gone: an agent stuck on a prompt that neither rings BEL nor fires a hook (Codex before 0.122, an unhooked Claude dialog) shows no badge.
- A questions badge queued in Focus Mode can fire after the task has already left `user-questions`.

## Alternatives considered

Keeping BEL as a quiet count without a reason: rejected, the number alone was the noise. Putting the reason text in the backend payload: rejected, it would reach the UI untranslated.
