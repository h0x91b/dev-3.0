# Task detail is requested by id on the board route, not driven by a card

## Context

Agent traffic's "Open task" went through `openTaskFromNotification`, which always
navigates to a terminal-bearing route (`{screen:"task"}` or `{screen:"project",
activeTaskId}`). A completed or cancelled task has no terminal, so the click landed
on an empty Active Tasks pane and read as doing nothing. The surface a finished task
already has is `TaskDetailModal`, which `TaskCard` opens on click for completed,
cancelled and todo cards.

## Decision

The project route carries `taskDetailId` (`src/mainview/state.ts`), and the pure
`taskOpenRoute()` in the same file is the single place that decides terminal route vs
board-plus-detail. `KanbanBoard` hosts the modal and resolves the id against its full
task list; `ProjectView` passes the id down and, once its fetch is `ready`, reports a
task that is not there (`task.detailGone`) instead of showing a blank board. The
traffic screen only says *whether* the node's task is archived
(`!ACTIVE_STATUSES.includes(status)`), the same predicate the card uses.

The obvious alternative — telling the matching `TaskCard` to open its own modal — was
rejected because a column renders only its first 15 cards until expanded, so a card
that is not on screen could not open anything, and a caller from another project has
no card at all at click time.

## Risks

The modal is now reachable without a card, so a future change that assumes "detail
modal ⇒ a card mounted it" is wrong. A close pushes a history entry, so Back reopens
the modal — the same shape the inline diff has.

## Alternatives considered

Resolving the task through a new single-task RPC (unnecessary: `getTasks` already
returns the project's whole list, the 15-card cap is purely visual); making every
notification path status-aware inside `App.tsx` (it cannot know the status of a task
in a project it has not loaded).
