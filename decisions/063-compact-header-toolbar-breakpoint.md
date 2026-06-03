# 063 — Compact header/toolbar layout for small screens

## Context
On a 14" MacBook (≤1512pt at default scaling) the top `GlobalHeader` action row and the `TaskInfoPanel` collapsed toolbar overflowed: buttons are `flex-shrink-0` with text labels, so once intrinsic width exceeded the viewport the `flex-1` spacer collapsed and clusters overlapped (e.g. the include-tests toggle colliding with "Find bugs"). On 16" (1728pt) everything fits.

## Decision
Introduced `src/mainview/utils/useCompact.ts` — a `matchMedia("(max-width: 1600px)")` hook built on `useSyncExternalStore` (SSR-safe, reacts to window resize). When compact:
- `GlobalHeader`: button text labels collapse to icon-only (tooltips kept) for Home/Project Terminal, Prevent-sleep, Pull, Remote, Project settings, Global settings; the low-frequency external actions (Website, Report, Change Log) fold into a single "More" (`\u{F01D9}`) overflow dropdown.
- `TaskInfoPanel`: labels hide on Watch, Find bugs, Spawn agent, and the include-tests toggle (icon-only + tooltip). The diff badge and status stay labelled.

`1600px` was picked because it cleanly separates a 14" (≤1512) from a 16" (1728) at default scaling and also fires when the window is shrunk on any display.

## Risks
- Viewport-based (not content-based): a very long task title in the breadcrumb can still crowd the header near the boundary. Accepted for v1; a ResizeObserver/content-aware upgrade is the planned v2.
- happy-dom's default test viewport is 1024px → compact. `GlobalHeader.test.tsx` now stubs `window.matchMedia` (defaults to roomy) so label-based assertions stay valid, plus a dedicated compact describe block.

## Alternatives considered
- **ResizeObserver / container query** — most robust, deferred to v2 (more code + tests).
- **flex-wrap to two rows** — rejected; vertical space is precious in a terminal-centric app.
- **Pure icon-only without overflow** — leaves the row long; user opted for the overflow menu for the three rare external actions.
