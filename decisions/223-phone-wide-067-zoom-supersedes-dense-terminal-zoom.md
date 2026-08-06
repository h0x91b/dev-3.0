# 223 — The 0.67× factor applies to every screen on a phone (supersedes 107)

## Context

[Decision 107](107-mobile-dense-terminal-zoom.md) applied `MOBILE_DENSE_FACTOR = 0.67`
only to terminal-bearing routes and explicitly rejected a global mobile zoom,
on the grounds that board, dashboard and settings were "already adapted".

Looking at a real phone (Chrome on Android, ~411 CSS px) proved otherwise: at
scale 1.0 the board, cards, modals and their controls read as oversized —
one and a half project cards per screen on the dashboard, and the Launch-task
modal footer squeezed its buttons to 32px so labels broke one word per line.
The user's verdict, twice: everything should be about half the size.

## Decision

`mobileFactor()` in `src/mainview/zoom.ts` returns `MOBILE_DENSE_FACTOR` whenever
`detectMobile()` is true, on every screen. The refcount (`denseScreens`,
`retainDenseZoom`, `notifyIfChanged`) and the `useMobileDenseZoom` hook are
deleted, along with their tests — there is nothing left to retain, and a
component-level request would now be a second helping of the same factor.

The user's saved zoom still multiplies on top, so ⌘+/⌘− and the Appearance
setting keep working from there; only the effective root font-size changes.
Absolute-px floors are unaffected by design: `.touch-actions` sheet rows stay
at true 44px, and the type scale's px-pinned rungs (nano 9px, dense 10px) stay
readable — that is why they are px and not rem.

## Risks

Text on a phone lands at ~10.7px for the 1rem rung. The px-pinned rungs and the
sheet rows are immune, but any surface that leans on rem for meaning-bearing
small text will read smaller than before; the type-scale test guards the pinned
rungs, the rest is a visual judgement each surface has to pass.

## Alternatives considered

- 0.75× — a softer step, rejected as too close to the status quo for the
  complaint being made.
- 0.5× — literally "half", rejected because it puts body text at 8px and equals
  the app's own `MIN_ZOOM`, leaving the user no room to shrink further.
- A separate Appearance toggle for mobile density — rejected: it adds a control
  to settings for something the app can decide from the device, and the existing
  zoom already covers the taste case.
