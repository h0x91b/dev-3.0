# An agent waiting on its own completion ask reads Has Questions

## Context

An agent that runs `dev3 task move --status completed` (or `cancelled`, or `todo` on a worktree task) blocks for up to 10 minutes on the user's answer. Its task stayed `in-progress`: the header said "Agent is Working", the board kept it in that column, and the Active Tasks sidebar filed it under WAITING, the tier for "nothing needs the user". With the "On the task" style the bar is the only cue, so the one task that needed the user ranked below everything that did not.

## Decision

`requestDestructiveApproval` (`src/bun/cli-socket/approvals.ts`) moves the task to `user-questions` while the request waits, and back to `in-progress` when the user declines. Both moves are guarded (`ifStatus`), so a status anything else set in the meantime wins. An approval moves the task to its target as before. Only the task's own agent parks it: the CLI now sends `sourceTaskId`, and a peer asking about another task leaves that task alone. Has Questions already means "an agent blocked on a reply", so the board, header, sidebar tier, `is:attention` and other clients agree with no new UI.

## Risks

Watchers of the task get the Has Questions status notification on top of the ask itself. A CLI older than this change sends no `sourceTaskId`, so its asks do not park. If the app quits mid-ask, the task stays in Has Questions until the agent's next turn moves it.

## Alternatives considered

- A client-side "has a pending ask" facet for the sidebar tier only: the board column, the header chip and `dev3 task show` would still say the agent is working.
- A new status: completion asks are a kind of question, and a new column is a bigger change than the problem.
