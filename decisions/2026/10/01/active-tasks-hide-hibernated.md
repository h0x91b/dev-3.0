# Not-running tasks leave the Active Tasks list by default

## Context

A hibernated task has no agent, terminal or dev server running; it waits until someone wakes it. A disconnected task (`isTaskDisconnected`: active status, worktree present, persisted `runtimeState.runtime === "idle"`, which boot rehydration writes when the terminal is gone) is in the same position from the user's side: nothing is running to jump to. Both still took rows in the Active Tasks sidebar, sunk to the bottom of their tier, so the jump list for the work in hand filled up with tasks nobody was running. `decisions/2026/09/07/hide-tasks-from-active-sidebar.md` had already added a per-task hide and a reveal eye for exactly this kind of clutter. The maintainer ruled that disconnected counts as hibernated for this purpose and needs no flag of its own.

## Decision

`isTaskNotRunning` (`src/mainview/utils/taskFacets.ts`) = hibernated OR disconnected. `ActiveTasksSidebar` leaves a task out of the default list when it is hidden OR not running (`isOutOfDefaultList`). The existing eye (`sidebar-show-hidden`) reveals both, with no new control or setting. The eye's tooltip counts the two groups apart ("2 hidden tasks · 1 hibernated or disconnected task"); a task that is both counts as hidden. The red dot still fires for a not-running task in an attention status. A new `is:hibernated` token (funnel flag "Hibernated or disconnected", offered only while such a task is in the pool) matches the same predicate on the sidebar and the board, and on the sidebar it reveals the rows by itself, like `is:hidden`. Waking or recovering the task changes its runtime, and the row returns on the next `taskUpdated` push. This is purely a render filter: nothing is written to the task. Review statuses and custom columns are untouched.

## Risks

After a crash, a forced quit or an updater kill, every active task is disconnected at the next boot, so the default list can come up empty. The eye's count and the "All active tasks are hidden" empty state are then the only way into the recovery path. Seq 2016 works on updater auto-recovery, which shrinks that window. A user who keeps hibernated review tasks will see the eye's red dot permanently. If the open task is not running and the eye is off, its row is absent, the same as for a manually hidden task. The board, Activity overview and task switcher are unchanged.

## Alternatives considered

- Making `is:hidden` also match these tasks would blur a token documented as "tasks you hid", and the board's funnel reads the same token.
- A separate `is:disconnected` token was rejected by the maintainer: it is the same thing as hibernated for this list.
- A separate reveal toggle was rejected: one eye covers both groups.
