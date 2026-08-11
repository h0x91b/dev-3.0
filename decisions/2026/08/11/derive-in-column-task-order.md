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

Drag-and-drop also carried Linear-style re-prioritization: dropping a card into another
priority band rewrote its priority. That is gone with the drag; priority is now changed
only via the card menu, the inspector badge, or `dev3 task update --priority`. Users with
a hand-built column order get a one-time reshuffle on upgrade.

## Alternatives considered

Keeping vertical drag purely as a re-prioritization gesture (drop into a band → set that
priority, position still derived) was offered and declined — a drag that visibly refuses
to leave the card where you dropped it is worse than no drag. Adding a real
`lastActivityAt` (agent output, UI focus, incoming message) was also considered and
rejected as scope: status changes already move on every meaningful lifecycle event.
