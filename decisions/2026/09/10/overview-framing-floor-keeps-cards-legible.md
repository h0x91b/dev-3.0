# The automatic traffic overview never frames below the legible tier

## Context

Experiment 2 of Agent traffic frames the whole graph on open, on resize, and whenever Live
Follow falls back to the overview. Card detail is a function of zoom: below `0.36` the
`cell` tier hides the entire card body (`traffic-nodes.css`,
`.traffic-nodes[data-detail="cell"] .traffic-node-card > * { display: none }`), leaving a bare
coloured rectangle.

On a phone the two rules meet badly. Measured on a 390×844 viewport (stage 390×419, nine
cards): the fit lands at **18%**, so entry is nine blank rectangles with no seq, title or
status anywhere on screen — reported as a side finding by Seq 1862 and re-measured here on
`main`. It is not a mobile-only defect: 41 cards on a 1440×900 stage fit at **14%** and give
the same wall of blank cells.

## Decision

`overviewScale()` in `src/mainview/components/agent-traffic/traffic-camera.ts` now takes a
`floor`, and `fit()` in `TrafficNodes.tsx` passes `IDENTITY_SCALE` (0.36) — the same constant
the `cell`/`compact` boundary uses, so the floor and the CSS tier cannot drift apart. The
automatic overview therefore opens at the lowest zoom where a card still carries its identity
and shows a centred part of the graph instead of all of it illegibly.

The user's own controls are untouched: pan, wheel zoom and the ± buttons still reach
`MIN_SCALE` (0.14), and the explicit **Fit everything on screen** button (plus the minimap's
fit) passes `exact` and stays a true whole-graph fit — the label would otherwise lie.

Detail-tier arithmetic moved into `traffic-camera.ts` as `detailTier()` / `IDENTITY_SCALE` /
`FULL_DETAIL_SCALE` so it is unit-testable; happy-dom has no layout engine, so the component's
own `fitNodes` cannot be exercised in a test.

## Risks

On a board large enough that even a desktop fit falls under 36%, entry now shows a subset of
the graph rather than all of it. That is deliberate — the "all of it" being replaced was
blank — but it is a visible change for big boards, not only for phones. The Fit button is the
escape hatch.

The floor is an absolute scale, like `MAX_SCALE` and the overview ceiling next to it. It is
calibrated on `CARD_WIDTH = 300`; a much wider or narrower card would need it re-measured.

## Alternatives considered

- **Keep the whole-graph fit and give the `cell` tier a tiny label** (seq only). Preserves the
  overview, but at 18% a 300px card is 55px wide, and Seq 1837 already measured counters as
  unreadable at 43%. Identity would be a number and nothing else.
- **Reflow the graph into one column on a narrow stage.** A layout rewrite, explicitly out of
  scope, and it would change the desktop graph's meaning too.
- **Floor only below a viewport breakpoint.** A magic width for a defect that is about scene
  size, not screen size — the 41-card desktop measurement above is the counter-example.
