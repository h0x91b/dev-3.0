# Waiting completion asks get their own screen

## Context

A user running many agents gets merge and agent completion asks on many tasks at once, and every open task holds an agent, a tmux session and memory. Each ask lives on its own task (`completion-offer-style-setting`), so freeing them meant opening task after task. `completion-offers-render-inline-not-modal` had rejected "a global pending-approvals tray" as a new surface for a rare event; for this user it is neither rare nor small: the list can reach a hundred tasks, too long for a section on the dashboard, whose job is the project list.

## Decision

A destination of its own, `{ screen: "completions" }` (`ReadyToCompleteScreen`), reached from a dashboard card that shows only while an ask waits (`ReadyToCompleteCard`) and from the palette (`view-completions`). It reads the same offer store the bar and the dialog use, one offer per task (`waitingOffers`), so an answer here settles the ask everywhere. A row's Complete asks in the same `confirm()` modal the Dialog style uses (`askOfferInModal`, closed by `offerSettledSignal` if the ask is answered elsewhere), in line with the maintainer's choice of the modal for a Complete outside the sidebar (#2259). The screen scales by search, a project filter and a sort (waiting longest, most memory), and frees many tasks by selection: one `confirm()` naming up to twelve of them, then a `getUnsavedWork` check per task that keeps open, with the loss shown, any task that would lose work. Each row carries the task's RSS (`taskResourceUsage`, keyed by the short task id) and the header the total held. A locked (sensitive) project's row is masked and has no actions. While the screen is mounted an ask raises no toast (`isCompletionOfferOnScreen`).

## Risks

The list shows only asks this client has raised; a client that missed a push catches up through the existing on-connect replay. Bulk completion is a destructive action behind one confirmation, kept safe by the per-task loss check rather than a second prompt. Rows are not virtualized; a few hundred rows render fine, thousands would not.

## Alternatives considered

- A section on the dashboard: built first, then dropped; a hundred rows push the project list off the screen.
- A header badge or tray: the header is over its button budget.
- A board column: completion is not a status, and a board is per project.
