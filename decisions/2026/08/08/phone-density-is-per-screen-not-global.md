# Phone density is per screen, not one global factor

## Context

`MOBILE_DENSE_FACTOR = 0.67` shipped as a single multiplier on the root
font-size for every screen on a phone (`src/mainview/zoom.ts`). It was tuned
against a task: the terminal, the diff and the inspector all want to show as
much as a ~400px viewport can hold. Applied to the Kanban board and the
dashboard, the same factor put a card title at 9.4px and made a column read as
a thumbnail of a desktop board.

## Investigation

Measured on a 390px viewport: at 0.67 a card title renders 9.38px; the user
asked for +25% on the board while explicitly keeping the task view as it is.
One global number cannot satisfy both, and raising it to 0.84 everywhere would
undo the task-view density that was the point of the factor.

## Decision

Two densities, chosen by route. `MOBILE_ROOMY_FACTOR = 0.84` (dense + 25%) for
screens the user browses — board, dashboard, settings, stats, changelog — and
`MOBILE_DENSE_FACTOR = 0.67` for the working set: `task`, `project-terminal`,
and `project` with an active task. The mapping is `mobileDensityForRoute()` in
`src/mainview/zoom.ts`; `App.tsx` calls `setMobileDensity()` from an effect on
`state.route`. Density is a module-level variable, not state: the root
font-size is a document-level property, and the terminal already listens to
`ZOOM_CHANGED_EVENT` to refit its canvas, which a density switch reuses.

The default is `roomy` because `bootstrapZoom()` runs before React and the
first route is the dashboard — defaulting to dense would re-scale the whole app
on first paint.

A `BottomSheet` is browsed and tapped, never worked in, so it renders roomy
even on top of a dense task screen. It does this with a local CSS `zoom` —
`overlayScaleUp()` returns `roomy / dense` = 1.25 — and not by moving the root
font-size: the sheet covers a live terminal, and re-scaling the root would
reflow the pty and send a `SIGWINCH` to the agent's shell because a menu
opened. Measured on a 390px viewport: panel still spans 0..390 flush to the
bottom edge, no horizontal overflow, rows 44px → 55px.

## Risks

The two px-pinned type rungs (`nano: 9px`, `dense: 10px`) do not scale with the
root font-size, so on a roomy screen they sit relatively smaller against their
rem-based neighbours than they did at 0.67. Measured on the board this reads
fine (a 10px label chip beside an 11.8px card title), but any future rung
pinned in px will drift further apart between the two densities.

A route that shows a terminal outside the four dense cases would get the roomy
factor and refit its canvas on entry. Today there is no such route.

CSS `zoom` is standardised but young outside Chromium; a browser that ignores
it degrades to the old, too-small sheet rather than breaking layout, and one
that mis-resolves percentages inside it would make the panel over-wide. Both
were checked in Chromium at 390px, not in WebKit.

## Alternatives considered

- **Raise the global factor to 0.84.** Rejected: the user is happy with the
  task view, and this makes the terminal and diff show a third less.
- **A user-facing "board density" setting.** Rejected: a preference for
  something the app can decide from the route, and it would need a home in
  Settings for one number.
- **Per-component `text-*` overrides on the board.** Rejected: it is the whole
  screen that is undersized, not a handful of labels, and it would fight every
  future component added to the board.
- **Flipping the root to roomy while a sheet is open.** Rejected: the sheet
  covers a live terminal, and the pty would resize under the agent.
- **Pinning the sheet's type in px instead of zooming it.** Rejected: its rows
  carry explicit rem-based `text-sm`/`text-xs` classes, so this is the same
  specificity fight as the `:is()` touch-target rule in
  `touch-target-floor-is-24px-and-never-overrides.md`, repeated per component.
