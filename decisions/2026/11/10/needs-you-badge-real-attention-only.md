# The red badge lights only for real attention

## Context

The count badge on a task card lit for a terminal BEL and for 15 seconds of terminal silence on an in-progress task. Agents ring BEL at the end of every turn and go quiet while they think, so the badge fired for work that did not need the user and trained them to ignore it.

## Decision

The badge has these sources: `dev3 attention`, a task newly entering `user-questions`, and the show-image / show-artifact / toast-overflow signals. BEL and idle no longer push anything: the `terminalBell` push, its queue kind, the renderer listener, `setOnIdle` and the PTY idle timer are deleted.

Entering `user-questions` is the lifecycle effect `raiseQuestionsAttention` (`questionsBadgeEffects` in `src/bun/lifecycle/machine.ts`), sent through `pushCliAttention` so Focus Mode queueing and project silencing apply. It is skipped for a move the UI made (`clientPlayedSound`) and for callers that raise their own badge with a reason (`callerRaisesAttention`: failed turns, agent exit, security hold). The payload carries `kind: "questions"` and the renderer words it with `kanban.badge.waitingForAnswer`.

BEL still moves an in-progress task to `user-questions`, but only for agents with no status hooks (`hasStatusHooks` in `src/shared/agent-adapters/registry.ts`; Cursor's hooks only account usage). For the others BEL can arrive before the Stop hook and park a finished turn.

## Risks

A hookless agent that rings BEL at every turn end still lands in `user-questions` and now raises the badge once through the move.

## Alternatives considered

Keeping BEL as a quiet count without a reason: rejected, the number alone was the noise. Putting the reason text in the backend payload: rejected, it would reach the UI untranslated.
