# The space rides into a task by reducer inheritance, not by threading call sites

## Context

A project may belong to several spaces (`base44-ft` sits in both `AI` and `base44`).
Which space the user came through is therefore not derivable from the project — it has
to travel with them. `routeSpaceId` already carried it on board routes and the history
stack stores whole routes, so Back/Forward was never the problem. Two things were:

- `screen: "task"` had no `spaceId` field at all, so full-page open lost the space.
- `ActiveTasksSidebar` derived its `space` scope from `project.id` via
  `spaceSiblingProjectIds` — the **union** of every space the project belongs to,
  which for a two-space project is never the board on screen.

## Investigation

Roughly thirty call sites navigate to a task (`TaskCard`, `TaskInfoPanel`,
`SiblingPopover`, `VariantSwitcher`, `useTaskSwitcher`, `ActivityOverview`,
`TmuxSessionManager`, `MemoryHeadroomIndicator`, `AgentTrafficIndicator`,
`useTaskBranchStatus`, `App`, `ProjectView`, `KanbanBoard`…). Most never see the route,
so threading `spaceId` through each would mean prop-drilling into a dozen components and
would silently lose the space at whichever one a future change forgets.

## Decision

Two pieces, both narrow:

1. `inheritSpace(from, to)` in `src/mainview/state.ts`, applied in `pushRoute` only.
   A destination that opens a task (`screen: "task"`, or a project route with
   `activeTaskId`/`taskView`) and names no space inherits the current route's. A **bare**
   board route is deliberately left alone — that is what the project switcher navigates
   to, where the click means "this project's own board", not "the space I was in".
   Inheritance is NOT applied in `stepHistory`/`replaceRoute`: Back and Forward must
   replay stored routes verbatim or the stack stops describing where the user has been.
2. `spaceScopeProjectIds(spaces, projectId, spaceId)` in
   `src/mainview/utils/spaceScope.ts`, used by `ActiveTasksSidebar` (fed `spaceId` from
   `ProjectView`). With a space it is that space's members; without one, or when the id
   no longer resolves, it falls back to the old union.

`routeSpaceId` now answers for task routes too. The task-store branches that meant "am I
on a multi-project board?" moved to a new, narrower `boardSpaceId` — a full-page task
route carries a space but renders no board.

`GlobalHeader` is untouched: the breadcrumb chip keeps naming the project once a task is
open (`GlobalHeader.tsx:425`), by the user's explicit call.

## Risks

- Inheritance is unvalidated by design: a route can name a space the target project does
  not belong to (a task opened from the global sidebar while on a space board).
  `spaceScopeProjectIds` drops such an id rather than narrowing the pool to nothing, and
  the header already resolves the space before showing it. Nothing consumes the raw id.
- Fullscreen open-mode users lose the space when a task is completed:
  `taskClosedHomeRoute` returns a bare board route, which does not inherit. Split mode
  (the default) returns `{ taskView: true }` and keeps it. Passing the space explicitly
  would need a new prop on three components that only hold `navigate`; not worth it for a
  destination reached only when a worktree is destroyed.

## Alternatives considered

- **A global `activeSpaceId` in `AppState`** ("remember the last active space"). Three
  lines, and it breaks Back/Forward: history returns the user to a space board while the
  variable still holds the last clicked space. Also stale on arrival from the dashboard.
- **Threading `spaceId` through all ~30 call sites.** Honest and explicit, but the prop
  drilling is large and a missed site fails silently. Rejected in favour of one rule.
- **A per-project sticky memory** (`dev3-project-last-space-<projectId>`) as a fallback
  when arriving with no space. Rejected for now: it makes the breadcrumb guess after a
  dashboard or ⌘K entry, and it is a second source of truth beside the route. Can be
  added on top later without changing this design.
