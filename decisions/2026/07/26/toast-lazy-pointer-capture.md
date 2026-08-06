# 172 — Capture the toast swipe pointer only after a drag starts

## Context

Clickable toasts (`toast.info(msg, { onClick })` — shared images, shared artifacts, agent
notifications) stopped navigating anywhere: clicking the context line or the message did
nothing, and the toast stayed on screen. The swipe-to-dismiss gesture (#1033) had taken
pointer capture on `pointerdown` for the whole card.

## Investigation

Reproduced in headless Chromium against the dev-server build: a real mousedown/mouseup on
the toast's inner button left the toast mounted and `onClick` unfired, while
`document.activeElement` had become that button. An active pointer capture retargets the
compatibility mouse events — and therefore the synthesized `click` — to the capturing
element, so the click landed on the card `div` (no handler) instead of the nested button.
The stray focus, a side effect of the retargeted mousedown, is what painted the blue
`:focus-visible` ring the user saw around the toast body in WebKit.

## Decision

`ToastCard.updateSwipe` (`src/mainview/toast.tsx`) now calls `setPointerCapture` on the
first pointer move past `SWIPE_DECIDE_PX` instead of on `pointerdown`. A tap therefore never
captures and its click reaches the button normally; a real drag still captures and keeps
tracking outside the card. Both toast buttons also `preventDefault()` on `mousedown` so a
pointer press never focuses them — the keyboard focus ring stays reserved for Tab.

The clickable target is the whole card, not just the text: the content is plain markup and
the action lives in an `absolute inset-[3px]` overlay button (accessible name = the toast
message) that sits under the dismiss button (`relative`, later in DOM order). The 3px inset
keeps the focus ring inside the card's `overflow-hidden` box instead of clipping it.

## Risks

Between `pointerdown` and the threshold crossing the pointer is uncaptured, so a very fast
fling that leaves the card before the first `pointermove` would lose the gesture. In
practice the first move arrives within a few pixels. `releasePointerCapture` is now called
for gestures that never captured — already inside a `try/catch`.

## Alternatives considered

Keeping capture and moving the click action to `pointerup` on the card: works, but duplicates
activation logic and loses the button's native keyboard semantics. Suppressing the focus ring
with a CSS override scoped to toasts: hides the symptom and breaks keyboard focus visibility.
