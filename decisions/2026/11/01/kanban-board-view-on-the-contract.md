# Kanban as `builtin:kanban`: what the board contract gained

## Context

Board views task 2 (spec `board-views-spec.md` §7–§8) replaces the old `KanbanBoard` with a board view that reads only
`ctx.board`. The temporary `LegacyKanbanBridge` fed the old component everything the contract did not carry:
`dispatch`/`navigate` for the cards, PR badges, lineage, bells, ports, dev servers, the column-management RPCs.

## Decision

- **`ctx.board.TaskCard`** (`board-views/BoardTaskCard.tsx`): the real dev3 card, bound by the host through a
  host-internal React context. A view passes only `task` and drag/moving state. No view ever sees `dispatch` or
  `navigate`, and extensions get the same card the Kanban draws.
- **Column actions** on `ctx.board` (`useBoardActions.tsx`): `renameColumn`, `createColumn` (before Completed),
  `renameCustomColumn`, `deleteCustomColumn` (same confirm), `reorderColumns`. Project boards only; on a space board
  they reject, because a merged lane has no single name or order.
- **`columns({ includeOccupied })`**: the default stays the config's lane set (a status picker must not lose an empty
  status); `includeOccupied` adds a hidden built-in that still holds a card, which is what a lane-drawing view needs.
- **`preferences()`** (`taskSortOrder`, `tipsDisabled`), following the settings push in the host.
- **`moveTask(id, to, { onMovingChange })`**; the custom-column path is now optimistic with revert, as the old board was.
- Host overlays, not contract: the task-detail modal (`detailTaskId`) and the draft-edit `CreateTaskModal` live in
  `BoardHost`; every launch, add-attempts included, goes through the app launch modal (`requestTaskLaunch`,
  `LaunchRequestedDetail.mode`), so the Kanban's private `LaunchVariantsModal` is gone.
- "Contract-only" means data and actions: a built-in view may import presentational host modules (`KanbanColumn`,
  `TipCard`, `MobileBoardCarousel`, i18n, `useColumnCollapse`) because it ships inside the app; it takes no props and
  no host bridge. Collapsed columns stay in `useColumnCollapse`'s localStorage, so nobody loses their collapse state.

## Risks

`BoardTaskCard` throws outside `BoardHost`; a view rendered elsewhere (a test, a future surface) must mount the
bindings context. The launch modal now always receives the task's own project, which fixes space-board launches
that used the anchor project but changes which project's agent defaults the modal reads there.

## Alternatives considered

Exposing `dispatch`/`navigate` on `ctx.board` — leaks the store into the public extension API. Per-signal accessors
(`pr(id)`, `bells(id)`, `lineage(id)`) without a card — every view would re-implement the card. Moving collapse state
into the view layout — a data migration with no user gain in this step.
