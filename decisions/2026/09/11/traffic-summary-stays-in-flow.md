# The Agent traffic summary stays in flow, never floated over the stage

## Context

On the Coordination view (`data-experiment="2"`) the scope title ("All active projects") and its
hint were absolutely positioned over the node stage at widths `≥ 901px`, with a transparent
background. The user reported the hint rendered underneath the "N tasks with no messages" /
"N parked" pills, and that the labels were unreadable over the dot grid.

## Investigation

The two boxes were anchored to **different containing blocks** with hardcoded pixel offsets, both
introduced by the same commit (#1673):

- `.traffic-summary` → `position: absolute; top: 108px` inside `.traffic-view` (view top).
- `.traffic-nodes-bands` → `top: 65px` inside `.traffic-nodes` (stage top, i.e. below the toolbar).

So the pills' real vertical position is `toolbarHeight + 65`, and they clear the summary only when
the toolbar is taller than about 96px. Measured in a real browser against these stylesheets with a
faithful DOM: toolbar 57px → pills at 122–147, summary hint at 137–150. The overlap is
unconditional at desktop widths and has nothing to do with viewport size; every toolbar change
moves one box and not the other. Below 901px the float never applied, and there the layout was
already correct.

## Decision

Deleted the `@media (min-width: 901px)` block in
`src/mainview/components/agent-traffic/traffic-nodes.css` that floated the summary and shifted the
bands. The summary now renders in flow above the stage at every width, on its own
`--surface-base` surface, and the stage overlays keep their single origin. Both magic numbers are
gone, so the layout no longer depends on the toolbar's height. The map caption at the bottom of the
stage got the same plate treatment as the band pills (`--surface-raised / 0.92` plus an inset
hairline), for the same readability reason.

## Risks

The stage loses about 52px of height on desktop (measured 1023 → 971 at 1920×1080), and the screen
loses the "labels floating over the canvas" look. Neither affects the camera, the layout algorithm,
or any behaviour.

## Alternatives considered

- **Retune `top: 65px` to clear the summary.** Rejected: it is the same magic number against the
  same wrong origin, so the next toolbar change breaks it again.
- **Keep the float, move the pills to the bottom-left.** Rejected: that corner belongs to the map
  caption, and the bottom-right to the camera controls.
- **Measure the toolbar in JS and publish it as a custom property.** Rejected as far more machinery
  than a layout this static needs.
