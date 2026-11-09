# Waiting completion asks are listed on the dashboard

## Context

A maintainer with many tasks gets merge and agent completion asks on many of them, and every open task holds an agent, a tmux session and memory. The ask lives on its task (a bar or a dialog), so answering all of them meant opening each task. `completion-offers-render-inline-not-modal` had rejected "a global pending-approvals tray" as a new surface for a rare event; for this user it is not rare.

## Decision

`ReadyToCompleteSection` renders at the top of the dashboard (`ActivityOverview`), above the project list, and only while an ask waits. It reads the same offer store the bar and the dialog use (`useCompletionOffers`, one unsolicited offer per task, oldest first via `offeredAt`), so an answer here settles the ask everywhere. Each row names the task and project, the kind, the wait and the task's RSS from `taskResourceUsage`, and offers Keep open and Complete; Complete runs `getUnsavedWork` and shows a new loss before a second click. "Complete all" asks once through `confirm()`, then completes every task with nothing to lose and keeps the rest open with their losses shown. A locked (sensitive) project's row is masked and has no actions.

## Risks

The list only knows asks this client has raised; a client that missed a push catches up through the existing on-connect replay. Bulk completion is a destructive action from one confirmation, kept safe by the per-task loss check, not by a second prompt.

## Alternatives considered

- A header badge or tray: the header is over its button budget, and the dashboard already lists tasks that wait on a human.
- A board column: completion is not a status, and the board is per project.
- No bulk action: the point is clearing many tasks quickly.
