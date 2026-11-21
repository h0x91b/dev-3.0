# An agent waiting on its own approval ask reads Has Questions

## Context

An agent that runs `dev3 task move --status completed` (or `cancelled`, or `todo` on a task with work to lose) blocks for up to 10 minutes on the user's answer. Its task stayed `in-progress`: the header said "Agent is Working", the board kept it in that column, and the Active Tasks sidebar filed it under WAITING, the tier for "nothing needs the user". The only cue was the approval dialog, so a task that needed the user ranked below tasks that did not, and a user who closed or missed the dialog had nothing on the board to find it by.

## Decision

`requestDestructiveApproval` (`src/bun/cli-socket/approvals.ts`) moves the task to `user-questions` while the request waits (`parkWhileAsking`). An approval moves the task to its target as before. Only the task's own agent parks it: the CLI now always sends `sourceTaskId`, and a peer asking about another task leaves that task alone. Has Questions already means "an agent blocked on a reply", so the board, header, sidebar tier, `is:attention` and other clients agree with no new UI.

On a decline, `unparkAfterDecline` asks whether any CLI still waits on the request: the original connection, a retry, or a re-attach (each handler gets its connection's abort signal). If one does, the task goes back to `in-progress`. If none does, the agent may have ended its turn while parked, and its Stop hook (guarded on `in-progress`) moved nothing, so the task takes that hook's move instead: `getPrimaryStopTarget`, Your Review or AI Review. Every move here is guarded on the status it expects, so a status anything else set in the meantime wins, and a park move that did not land in `user-questions` is never undone.

The park move passes `skipQuestionsBadge`, like the parks in `agent-commands.ts`: the ask is already the cue, and a badge would outlive an ask the user answered from the dialog without opening the task. The Has Questions sound still plays once, since the dialog plays none.

This is a change of default behaviour. It applies to every completion ask, whatever style shows it, and to cancel and reset asks, because all three block the asking agent the same way.

## Risks

- While parked, the Stop hook's `--if-status in-progress` move is refused. The decline path above covers an asker that is gone; an app quit mid-ask leaves the task in Has Questions until the agent's next turn moves it.
- Claude Code moves a Bash call to the background after its default 120 s timeout. The agent runs on, and its next PreToolUse hook moves the task back to `in-progress` while the dialog is still open, so a park often lasts about two minutes. A later decline then changes nothing.
- "Own agent" means any process whose CLI context resolves to the task, by its worktree cwd or by `DEV3_TASK_ID`, not only the agent pane. A second spawned pane or a human shell in the worktree that asks parks the task too.
- `user-questions` is in `MERGE_COMPLETE_ELIGIBLE_STATUSES`, so a parked task runs the merge watch. A PR that merges during the ask can raise the "Branch merged, complete?" prompt next to the agent's own ask. Completing from that prompt voids the ask as stale, and the agent learns the task is already completed.
- Watchers of the task get the Has Questions status notification on top of the ask itself. A CLI older than this change sends no `sourceTaskId` without `--reason`, so its asks do not park.

## Alternatives considered

- A client-side "has a pending ask" facet for the sidebar tier only: the board column, the header chip and `dev3 task show` would still say the agent is working.
- A new status: approval asks are a kind of question, and a new column is a bigger change than the problem.
- Parking completion asks only: cancel and reset asks block the agent the same way, and splitting them would make the status depend on which question is pending.
- On a decline with no CLI waiting, leave the task in Has Questions: an agent whose turn ended then sits in Has Questions instead of the review lane its Stop hook would have chosen.
