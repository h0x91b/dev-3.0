# Size the traffic scene layer instead of forcing a repaint

## Context

Agent traffic Experiment 2 left clipped card fragments on screen at low zoom: cards
rendered at an earlier, larger detail tier stayed painted in vertical bands beside the
correct `cell`-tier rectangles, and a pan cleared them instantly. The obvious reaches —
`will-change`, `translateZ(0)`, an unconditional redraw tick — are all blanket GPU
workarounds that hide a cause instead of naming one, so none of them was taken.

## Investigation

`.traffic-nodes-scene` and `.traffic-nodes-cards` measured **0×0** while painting the
whole graph: both are `position: absolute` with no size, and every card inside them is
absolutely positioned, so nothing gives the boxes height. Measured in the running app
(`getBoundingClientRect`) at 3840×2160, 1440×900 and 390×844 — zero at all three, while
the sibling `<svg class="traffic-nodes-wires">`, which is given `width`/`height`
explicitly, measured the real scene. That asymmetry also shows in the original report:
the residue is cards only, and no stale wire fragments appear beside them.

One hypothesis for why that matters — untested here — is that an empty layout box yields
a damage rect that misses the painted descendants. It is a hypothesis, not a measured
cause, and nothing below depends on it being right.

The artifact itself was **not** reproduced: it did not appear in headless Chromium (via
`agent-browser`) or headless WebKit (via `playwright-core`), on a standalone harness or
on the running app. Those clean runs establish only that these configurations did not
show it — not why. The reported behaviour comes from the native Electrobun window, and
that is where reproduction and verification still have to happen.

## Decision

`TrafficNodes.tsx` passes `scene.width` / `scene.height` into the scene div's inline
style — the same two numbers already handed to the wires `<svg>` a few lines below — and
`.traffic-nodes-cards` takes `width: 100%; height: 100%` off it in `traffic-nodes.css`.
Guarded by "sizes the transformed scene layer to the graph it paints" in
`src/mainview/__tests__/agent-traffic-ui.test.tsx`, which fails without the change.

## Risks

The causal link to the reported artifact is **unproven**. The zero-sized boxes are
measured; that they are what produced the fragments is not. Nobody has watched the
fragments stop appearing in the native window. If they survive, this change is still
correct on its own terms and the next suspect is elsewhere; do not layer a GPU workaround
on top of it without first reproducing in the native window.

## Alternatives considered

`will-change: transform` or `translateZ(0)` on the scene — promotes a layer and usually
masks the symptom, but pins a full-graph texture in video memory and explains nothing. A
redraw tick on camera change — burns a frame forever to paper over one invalidation bug.
Both were rejected as blanket workarounds.
