# The diff view is a back/forward history step

## Context

Opening a task's diff replaces the whole workspace, so it reads as a separate page — and
Back was expected to return to the task. It did not: the diff lived in component state
(`useTaskInlineDiffState`, a `useState` in `ProjectView` / `TaskWorkspaceView`) while every
Back gesture — `Cmd+[`, mouse button 3, the header arrow, the native menu, the command
palette, the Android back guard — dispatches `goBack` on the route-history stack in
`state.ts`. Back therefore skipped straight past the task to whatever came before it, and
Forward could not bring the diff back at all.

## Decision

The diff's open/closed state moved onto the route as an optional `diff` field on the
`project` and `task` variants of `Route` (`src/mainview/state.ts`). Opening dispatches
`openTaskDiff`, which pushes a history entry; closing dispatches `closeTaskDiff`, which
*steps back* rather than pushing, so Forward still returns to the diff. Re-opening while
already in the diff replaces the current entry instead of stacking a second one.
`useTaskInlineDiffState(route, dispatch)` is now a thin reader over the route.

It is deliberately **not** a new `screen`: the UX manifest classifies the diff viewer as a
surface whose forbidden list includes "global destination", and a new destination would cost
a breadcrumb segment and a slot in the ≤7 destination budget. Riding the task route buys the
history semantics and changes nothing about navigation itself.

## Risks

Every Back entry point funnels through the same reducer, so one change covers all of them —
but that also means a mistake here breaks all of them. Verified in a browser
(`agent-browser`, remote mode) across the header arrows and `Cmd+[` / `Cmd+]`; the Electrobun
desktop shell runs the same renderer bundle and was not driven separately. Routes are not
persisted, so a reload while on the diff still lands on the dashboard — unchanged.

## Alternatives considered

- **A module-level intercept stack that `goBack` consults first**, like `registerBackLayer`.
  A much smaller diff, but it can only *swallow* a Back press — Forward could never restore
  the diff, which is half of what was asked for.
- **A new `screen: "diff"` route.** Clean on paper, but it makes the diff a destination: a
  breadcrumb segment, a nav budget slot, and a route the whole app has to handle. Rejected
  against the manifest.
- **Making every in-task panel a history entry** for consistency. Rejected outright: it
  floods a 15-entry stack and makes Back unpredictable. The rule written into the UX bible is
  that only a full-bleed replacement of the surface underneath earns a history step.
