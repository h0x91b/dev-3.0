# Coordinators sit in a headerless top tier of the Active Tasks sidebar

## Context

Live coordinators were lifted inside NEEDS YOU, so a coordinator jumped between tiers whenever its status or custom column changed. The task the user talks to in order to reach all the others was never in a stable place.

## Decision

`groupTasksIntoTiers` (`src/mainview/components/sidebarTiers.ts`) puts every non-hibernated coordinator in a `coordinators` tier, rendered first and without a header row (`ActiveTasksSidebar.tsx`), whatever its status or custom column; disconnected ones stay in it. A hibernated coordinator falls through the normal rules. NEEDS YOU now leads only with `user-questions`. The board Table and Tree pin with `isPinnedCoordinator` (`src/shared/types/task-type.ts`), which also requires an active status, because those views list finished tasks and a completed coordinator must not stay on top.

## Risks

The coordinators tier has no label, so a user must recognise it by the role chip on its rows. The sidebar and the Table/Tree use two different predicates (`isCoordinatorTask && !hibernated` versus `isPinnedCoordinator`); they differ on purpose, but a future change to one must consider the other.

## Alternatives considered

Keeping the lift inside NEEDS YOU (the old behaviour) leaves the jumping. A tier headed "Coordinators" was rejected by the user, who wanted no header.
