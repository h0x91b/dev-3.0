# 181 — Occupancy outranks config in board column visibility

## Context

`getBoardColumns` (`src/shared/types.ts`) hid the PR Review column whenever
`peerReviewEnabled === false`, and hid both AI Review and PR Review on virtual
("Operations") boards — unconditionally. AI Review already had an escape hatch
(`aiReviewHasItems`), PR Review had none.

A hidden column still receives tasks: the lifecycle machine, the CLI, and task
moves all write those statuses regardless of column visibility. The card then
renders nowhere while remaining in `tasks.json` and answering to
`dev3 task show` — and a restart does not bring it back, which reads as data
loss. This surfaced while investigating issue #1170 (a task visible to the CLI
but never on the board); it is not confirmed as that reporter's cause.

## Decision

Column visibility now takes occupancy as an override: `getBoardColumns` accepts
`opts.occupiedStatuses` (the built-in statuses currently holding at least one
card) and `shouldHide` returns false for any status in that set. The old
`opts.aiReviewHasItems` boolean is gone — replaced, not deprecated. `KanbanBoard`
computes the set from the **unfiltered** task list, so the board's search filter
cannot hide a column out from under its cards.

Companion fix in the same change: `partitionTasksByStatus`
(`src/mainview/components/partitionTasks.ts`) routes a task with an unrecognized
status into To Do rather than letting an optional-chained `Map.get(...)?.push`
drop it silently.

## Risks

A user who turns peer review off, or converts a board to Operations, keeps
seeing the review column until it empties out — mildly surprising, but the
alternative loses cards. No data or on-disk format is touched.

## Alternatives considered

- **Auto-move occupied cards to a visible status** when a column hides — mutates
  user data as a side effect of a settings toggle; rejected.
- **Refuse the settings change while the column is occupied** — blocks a
  legitimate config change on unrelated task state; rejected.
- **Badge the orphaned cards** in a dedicated "unknown status" tray — new UI
  surface for a state that should not occur; To Do is already the correct
  fallback.
