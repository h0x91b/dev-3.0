# Pin live coordinators above the sidebar tiers

## Context

A live coordinator was lifted to the top of its own readiness tier, so it jumped between NEEDS YOU and WAITING every time its status changed and was hard to find. Its hazard-tape look (hi-vis stripes, dashed lime border) also read as danger rather than as identity.

## Decision

`groupTasksIntoTiers` (`src/mainview/components/sidebarTiers.ts`) takes every live coordinator (not hibernated, not disconnected) out of the tiers and returns it as a leading `coordinators` group; `ActiveTasksSidebar` renders it first, without a header. A coordinator therefore leaves its custom column in the list, and a column holding only coordinators produces no tier. Parked and disconnected coordinators stay in their tier. The tape is replaced by a lime crown title and a solid Coordinator badge on the card, the row and the dashboard.

## Risks

A coordinator parked in a custom column on purpose is shown above all tiers while it is live. Several live coordinators share one headerless block, ordered by priority band and activity clock.

## Alternatives considered

A separately labelled section: rejected, it costs a header for what is usually one row. Keeping the lift inside each tier: rejected, the row keeps jumping between tiers.
