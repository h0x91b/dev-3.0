# 107 — Mobile terminal/diff screens render denser (dense zoom)

## Context

On phones the task terminal screen (and the diff viewer) had no room — chrome ate the screen and little terminal content fit. The rest of the mobile UI (board carousel, dashboard, settings) is already adapted and should keep its scale, so a global mobile zoom was rejected after trying it.

## Decision

`retainDenseZoom()` in `src/mainview/zoom.ts`: a refcounted request for a `MOBILE_DENSE_FACTOR = 0.67` multiplier (1.5× denser; started at 0.5, relaxed after user feedback) on top of the user's zoom. It reuses the root-font-size scaling, so px-based media queries (`useNarrowViewport`, 768px carousel breakpoint) are untouched and the mobile layout stays mobile. `useMobileDenseZoom(route)` in App retains it on terminal-bearing routes (`task`, `project-terminal`, `project` with `activeTaskId`/`taskView` — same predicate family as `needsDesktopViewport`/`inTaskView`); the diff viewer lives inside those routes. The factor only applies when `detectMobile()` (shared `screen.width < 1024` check); on desktop `retainDenseZoom` is a visual no-op. `ZOOM_CHANGED_EVENT` detail now carries the *effective* zoom (user × factor) — `TerminalView` sizes its font from `getEffectiveZoom()`, while `GlobalSettings` displays `getZoom()` (the saved setting).

## Risks

Navigating into/out of a task visibly re-scales the UI on mobile (accepted — full-screen transition anyway). The persisted zoom setting is never multiplied in; if a future call site writes `getEffectiveZoom()` into `applyZoom`, the factor would compound — keep the two APIs distinct. Refcounting exists because StrictMode double-mounts effects and diff/terminal screens can overlap.

## Alternatives considered

Global mobile zoom 0.5 (implemented first, reverted — board/dashboard got too small and looked broken). Viewport `initial-scale=0.5` — doubles layout width past the 768px breakpoint, silently flipping phones to the desktop layout. CSS `zoom: 0.5` on the task container — bitmap-scales the canvas terminal (blur) and skews `getBoundingClientRect` math.
