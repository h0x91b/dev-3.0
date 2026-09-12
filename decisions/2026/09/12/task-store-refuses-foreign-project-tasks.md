# The task store, not its callers, decides which board holds a task

## Context

`currentProjectTasks` holds exactly one board's tasks. Several reducer branches append to it:
`updateTask` (a task arriving from a push), `addTask` (creation), `spawnVariants` and
`addAttempts` (a launch). Only `updateTask` checked the route. Creating a task into project B
from project A's New Task dialog and pressing Launch therefore put B's card on A's board until
the next fetch replaced it — `CreateTaskModal` guarded its own `addTask` dispatch, but nothing
guarded the `spawnVariants` the launch dispatched right after.

## Decision

One helper, `acceptsTaskFrom(state, projectId)` in `src/mainview/state.ts`, answers the question
for every appending branch: a project board takes only its own project's tasks; a space board
takes anything, because `ProjectView` and `ActiveTasksSidebar` filter by space membership
themselves. `updateTask`, `addTask`, `spawnVariants` and `addAttempts` all go through it, and the
call-site guard in `CreateTaskModal` is gone — the modal reports what it created and the store
decides.

## Risks

A dispatch made while no project board is on screen (dashboard, settings) is now dropped instead
of stored. That is intended: nothing renders those cards, and the board refetches on entry.

## Alternatives considered

Guarding at each call site (the launch modal too) — same bug one dispatch later, and each site
would have to learn the route. Filtering in the board component instead — cosmetic hiding that
leaves the foreign task in the store for the split view and the task switcher to find.
