# Derive in-column task order instead of storing it

## Context

Tasks inside a Kanban column were ordered by a persisted `Task.columnOrder` written by
vertical drag-and-drop, while the Active Tasks sidebar ignored that field entirely and
sorted oldest-`movedAt`-first. The two surfaces routinely disagreed about the same
tasks. Issue #1314 asked for an MRU order; the user wanted the opposite (longest
untouched on top) and a setting to pick.

## Decision

In-column order is now **derived**: strict priority bands, then an activity clock, then
`seq`. The clock is `statusEnteredAt ?? movedAt ?? createdAt` — "when this task last
changed status", deliberately not a general last-touched stamp, which does not exist and
was not worth inventing. Direction comes from `GlobalSettings.taskSortOrder`
(`oldest-first` default / `newest-first`), and one comparator — `compareTasksInBand` in
`src/mainview/components/sortTasks.ts` — serves both the board (`sortTasksForColumn`) and
the sidebar (`groupTasksIntoTiers`), so they cannot drift again.

Consequently removed: vertical drag-reorder in `KanbanColumn`, the `reorderTask` RPC and
`data.reorderTasksInColumn`, every read and write of `Task.columnOrder`, the
`dropPosition` write option threaded through `data.updateTask` and the lifecycle
executor, and the `taskDropPosition` setting. `Task.columnOrder` stays declared in the
type so existing values in `tasks.json` survive a load/save round-trip for older builds
still reading them (frozen on-disk layout).

## Risks

Vertical drag inside a column also carried Linear-style re-prioritization: a card dropped
into the stretch of the column occupied by a different priority band inherited that band's
priority (`reorderTasksInColumn` read the neighbour it landed on top of and wrote its
priority onto the whole variant group). That gesture is gone with the drag; priority is
now changed only from the card's priority badge menu, the task inspector, the task detail
modal, the Active Tasks sidebar badge, or `dev3 task update --priority`. Users with a
hand-built column order get a one-time reshuffle on upgrade.

A variant group is no longer held together inside a column. `sortTasksForColumn` used to
keep cards sharing a `groupId` adjacent; now every task is placed by its own activity
clock, so an unrelated card can sit between two variants of the same task (which also
share one `seq`). Deliberate — variants are independent attempts and priority is written
group-wide anyway, so they still share a band — but it is a visible change, and the
grouping is the thing to restore first if epics land.

## Alternatives considered

Keeping vertical drag purely as a re-prioritization gesture (drop into a band → set that
priority, position still derived) was offered and declined — a drag that visibly refuses
to leave the card where you dropped it is worse than no drag. Adding a real
`lastActivityAt` (agent output, UI focus, incoming message) was also considered and
rejected as scope: status changes already move on every meaningful lifecycle event.
