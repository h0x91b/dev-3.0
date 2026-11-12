# Coordinators sit in a headerless top tier of the Active Tasks sidebar

## Context

Live coordinators were lifted inside NEEDS YOU, so a coordinator jumped between tiers whenever its status or custom column changed. The task the user talks to in order to reach all the others was never in a stable place.

## Decision

`groupTasksIntoTiers` (`src/mainview/components/sidebarTiers.ts`) puts every non-hibernated coordinator in a `coordinators` tier, rendered first and without a header row (`ActiveTasksSidebar.tsx`), whatever its status or custom column; one waiting on a reply (`user-questions`) leads it, as questions lead NEEDS YOU. Disconnected ones belong to the tier but, like every not-running task, show only when hidden tasks are revealed. A hibernated coordinator falls through the normal rules.

The board Table and Tree pin with `isPinnedCoordinator` (`src/shared/types/task-type.ts`): not hibernated and in an active status, because those views list finished tasks and a completed coordinator must not stay on top. A disconnected coordinator stays pinned — after a restart every coordinator is disconnected until reattached, and that is exactly when the user looks for them. In the Tree a pinned coordinator also lifts the branch that holds it (`buildTaskTree`), so one created from another task is never buried below the fold; it stays nested to keep lineage honest. The accent row tint marks pinned rows only; the role chip marks every coordinator.

## Risks

The coordinators tier has no label, so a user must recognise it by the role chip on its rows. The sidebar keys on `isCoordinatorTask && !hibernated` (its pool is already active-only) and the Table/Tree on `isPinnedCoordinator`; a future change to one must consider the other. A lifted Tree branch whose parent is collapsed still hides the coordinator one click away.

## Alternatives considered

Keeping the lift inside NEEDS YOU (the old behaviour) leaves the jumping. A tier headed "Coordinators" was rejected by the user, who wanted no header. In the Tree, hoisting a nested coordinator to a root breaks lineage, and force-expanding its ancestors makes them impossible to collapse.
