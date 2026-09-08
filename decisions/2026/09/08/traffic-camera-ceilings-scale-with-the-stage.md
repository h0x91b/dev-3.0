# The traffic overview scales with the stage; Follow clamps to the scene

## Context

The agent-traffic node stage has three automatic framings, each capped by a flat
scale: overview fit at `0.85`, the Follow pair framing (`frameExchange`) at `1.03`,
and single-card Focus at `1.12`. All three were calibrated on a laptop-sized stage.

A 4K report came in with two symptoms at once — "excessive empty space" and "content
offscreen". The screenshot's own zoom readout says **103%**, and the card grid measures
363 physical px per 352-unit column pitch, so the user was at DPR 1 on a 3840×2160 CSS
viewport with Follow on, sitting exactly on the `1.03` pair ceiling. Two cards worth of
graph in the middle of a 3840-wide stage is both symptoms: the framed pair is small and
padded, and everything the camera centred away from is outside the viewport.

## Investigation

Reproduced on a seeded two-project QA board at a 3840×2160 viewport. Overview fit hit the
`0.85` ceiling and filled 73% of the stage width and **41%** of its height, with 523 px of
empty margin on each side and ~555 px above and below; cards rendered 255 px wide.
At 2560×1440 and below the fit arithmetic binds well before any ceiling (72%, 53%, 40%,
28% at 2560/1920/1440/1024), so those stages were never the problem.

## Decision

Two different fixes, because the two framings fail for two different reasons.

**Overview fit — the ceiling scales.** `stageCeiling(viewport, calibrated)` in
`traffic-camera.ts` multiplies the calibrated `0.85` by
`max(1, min(width/1600, height/900))`, clamped to `MAX_SCALE` (2.2, now exported from the
same module so hand-zoom and auto-framing share one roof). The ceiling becomes a share of
the screen rather than an absolute scale, so the whole graph keeps the size it always had
*relative to the stage*. `max(1, …)` leaves any stage at or below 1600×900 untouched, and
the smaller axis drives the factor so a wide, short stage does not balloon. Measured: 4K
fit 85% → 108% (fill 93%/53%, cards 325 px, nothing clipped); 2560, 1920, 1440 and 1024
are byte-identical because the fit arithmetic still binds there.

**Follow — the scale stays, the camera clamps.** Scaling the pair ceiling too was tried
first and was wrong: on 4K it framed the pair at 217% with 650 px cards, which magnifies a
card without telling the reader anything new and still left a blank band. The pair's `1.03`
is already its natural, legible size. What a big stage buys is *context*, and the camera
was throwing it away — `frameExchange` centres on the pair, so on a stage wider than the
whole graph it spent the extra room on blank canvas while the rest of the graph sat
outside the viewport. `clampToBounds` pulls the camera back inside the scene: an axis the
scene overflows is clamped to its edge, an axis it does not fill is centred on the scene.
`TrafficNodes` passes the scene bounds (the same 70/86 padding `fitNodes` uses).
Measured at 4K Follow: 103% both before and after, but `clipped` goes true → false and the
fill goes 88%/70% with the second project and the blank top band both resolved. At 1440×900
and 1024×768 the scene still overflows, so the pair stays centred and both framed cards
stay fully on screen.

Focus (single card, `1.12`) is untouched and unclamped: it is an explicit "zoom to this
card", and clamping it to a scene that fits would refuse the thing the user asked for.

## Risks

- A very large stage with very few cards now fits at a higher zoom than before. Bounded by
  `MAX_SCALE`, and checked by eye on a 6-card 4K board — legible, not grotesque.
- The reference stage is a judgement, not a measurement. It is one constant in one
  function, and the guard tests pin both its ends.
- The clamp changes Follow on a stage the scene fits: the camera stops panning between
  events and holds one framing. That is fewer camera jumps, not more, and the framed pair
  is still lit and still carries its message bubble.

## Alternatives considered

- **Raise the three flat ceilings.** Fixes 4K and breaks the calibrated laptop framing,
  because a flat number cannot be right for both.
- **Scale the pair ceiling too.** Tried, measured, rejected — see above.
- **Cap by a target card width in px.** Same failure in reverse: "legible" is a share of
  the viewport, not an absolute width, so it re-creates the bug on the next screen size.
- **Drop the ceilings entirely.** A single-card scene would fill the stage with one card.
