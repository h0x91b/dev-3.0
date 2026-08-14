# Bottom sheet max-height is divided by its own CSS zoom

## Context

`BottomSheet` scales itself up with CSS `zoom` (`overlayScaleUp()`, 1.25) so a browse-and-tap
sheet reaches the roomy phone size while the task screen underneath stays dense. Its height cap
was the Tailwind class `max-h-[85dvh]`.

## Investigation

Measured in headless Chromium at a 393×660 phone viewport, task actions sheet open:
computed `max-height: 561px` (85% of 660) but `getBoundingClientRect()` returned
`height 701.25`, `top -41.25`. `dvh` resolves against the viewport *before* `zoom` scales the
rendered box, so 85dvh renders as 85·1.25 = 106dvh. The flex container aligns to `items-end`,
so the overflow goes off the *top*: the sticky header — grabber, title, close button, and the
only swipe-to-dismiss surface — sat above the viewport, and the panel covered the full width,
leaving no backdrop to tap. On a phone (no Esc, no Android Back on iOS) the sheet could only be
left by picking an action.

## Decision

`src/mainview/components/BottomSheet.tsx` sets `maxHeight: calc(85dvh / scaleUp)` inline instead
of the class, so the *rendered* panel is 85dvh at any scale. The backdrop dismiss handler moved
from `onMouseDown` to `onPointerDown` — iOS does not reliably synthesize mouse events for a tap
on a plain non-interactive div.

## Risks

`calc()` with a runtime-interpolated divisor is not type-checked; `scaleUp` is a finite number
from `overlayScaleUp()` and never 0. At `scaleUp === 1` the value is `calc(85dvh / 1)`, identical
to the old cap.

## Alternatives considered

Scaling the sheet through the root font-size instead of `zoom` — rejected for the reason already
in the code: it would reflow the terminal behind the overlay and resize the agent's shell just
because a menu opened. Making the whole panel swipe-dismissable would hide the symptom without
fixing the clipped header or the unreachable backdrop.
