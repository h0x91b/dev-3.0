# Traffic wires: parallel lanes, a colour per connection, and a flow that shows direction

## Context

In Agent traffic Experiment 2 every wire leaving a card left from the same port (`x + width / 2`)
and every wire between two rows shared one bus line, so a coordinator with eight children drew eight
wires stacked on top of each other — one thick trunk where only the topmost wire was visible. Colour
carried status only (`--agent` for everything, `--danger` for undelivered), so two wires in the same
corridor were indistinguishable, and direction was only visible while a replayed message's flight
circles happened to be on screen.

A bounded prototype (Seq 1858, artifact "Линии трафика: варианты разводки") measured four options on
a reconstruction of the reported screenshot: overlapping ink dropped from 4889 px to 0 px once ports
and bus lines were spread onto lanes. Colour alone changed nothing — the geometry was still identical,
so the wires still hid each other. The user picked lanes + one solid colour per wire + a running wave.

## Investigation

The router (`nodes-routing.ts`) already avoids cards with A*, so nothing about obstacle avoidance
needed to change. The trap was its grid: candidate lines come from obstacle edges **plus exactly the
ports `wire()` picks** (`box.x + box.width / 2`, `box.y + box.height * 0.52`). A port moved off centre
is not on the grid, `xIndex.get(start.x)` returns `undefined`, and the router returns `null` — which
`layoutTraffic` treats as "unroutable" and **silently drops the edge**. Lanes therefore cannot be a
post-processing step over routed points, and cannot be introduced without teaching the grid about them.

## Decision

- `wire-lanes.ts` (new) plans lanes for the whole scene before routing: `planLanes()` groups vertical
  pairs by the upper card (ports on its bottom edge), by the lower card (ports on its top edge), and by
  corridor (`topKey|round(baseBus)`), sorts each group by where the wire is heading, and hands out
  offsets `(i - (n-1)/2) * step`. Steps compress when a group does not fit, and `LanePlan.compressed`
  records that. Deterministic: the same scene always yields the same lanes.
- `createTrafficRouter(boxes, extra)` now takes the lane coordinates as extra grid lines
  (`laneGridLines()`), which is what keeps a fanned-out wire routable.
- `wire()` in `nodes-layout.ts` takes an optional `LanePlan` and falls back to the old centred port and
  `baseBus()` when there is none, so a wire with no plan (a same-row exchange) is unchanged.
- Colour: 16 categorical `--wire-1 … --wire-16` tokens in `index.css`, both themes, generated in OKLCH
  at one lightness and one *share* (94%) of each hue's own maximum chroma — equal absolute chroma would
  make the blue wire look washed out next to the yellow one. Dark theme sits at L 0.74, light at L 0.58
  (measured: `--surface-raised` is L 0.202 dark and L 1.0 light, so a single lightness cannot serve both).
  `PlacedEdge.colorIndex` comes from FNV-1a over the pair key, so a connection keeps its colour when
  neighbours appear or disappear. `TrafficNodes` passes it as `--wire: var(--wire-N)`; no component holds
  a literal colour.
- **Status still wins over identity.** `.traffic-wire.verdict-not-delivered` keeps `--danger` and its
  dash, declared after the palette rule, so "this failed" is never repainted as "this is connection #7".
- Flow: a second `<path>` per delivered wire with a 15/26 dash, animated by decreasing
  `stroke-dashoffset` one cycle per `--flow-duration`. Decreasing is the direction that moves the pattern
  toward the end of the path — the path runs sender → recipient, so the wave runs the same way. Dash
  lengths divide by `view.scale`, exactly like `strokeWidth`, so the wave keeps one on-screen size and
  one speed (34 px/s) at every zoom. One speed for every wire: a per-wire speed reads as noise, not as
  direction. The wave is not rendered at all when `useReducedMotion()` is true, on a dim wire, or on an
  undelivered one.

## Risks

- **Lanes do not cover the vertical channels between rows.** Once a wire has to pass the first row to
  reach the second, which gap it takes is A*'s decision, and two wires can still share part of one
  channel. Measured on the 8-child coordinator scene: 196 px of shared run remains (0 px when every
  recipient is in one row). `nodes-layout.test.ts` pins that budget at under 300 px rather than
  pretending it is zero.
- A crowded corridor compresses lane steps until wires nearly touch again; the plan degrades instead of
  dropping wires, and a test covers 20 wires out of one coordinator.
- 16 hues are more colour than this screen carried before. Mitigated by keeping lightness and chroma
  share equal across hues, painting the wire body at 0.32–0.55 alpha, and leaving status colours in charge.
- A missing `--wire-N` token would fail silently (the wire falls back to violet), so
  `wire-tokens.test.ts` asserts all 16 exist in both themes as raw RGB triplets; it was verified to fail
  when one token is renamed.

## Alternatives considered

- **Offsetting routed polylines after A*** — cheaper, but a shifted segment can cut through a card,
  which is exactly the guarantee the router exists to provide.
- **Colour only, no lanes** (prototype option C) — measured: overlapping ink unchanged at 4889 px,
  because coincident geometry still hides every wire but the last drawn one.
- **Two-colour twisted pair per wire** (prototype option D with palette 3) — liked in the prototype and
  rejected by the user in favour of solid wires; the twist added a second dash layer per wire for a
  signal the lane already carries.
- **Arrowheads for direction** — no marker infrastructure exists in this SVG, and an arrow at one end
  says less than a wave along the whole run.
