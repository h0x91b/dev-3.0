# The wheel bridge only runs where the pointing device has no horizontal axis

## Context

`decisions/2026/08/29/plain-mouse-wheel-horizontal-scroll.md` added a
document-level bridge that hands a purely vertical wheel delta to a
horizontal-only scroll container, so a plain mouse could reach the Kanban board.
It keyed on `deltaX === 0` as the signature of a mouse.

## Investigation

That signature is wrong. A trackpad's *vertical* two-finger swipe also arrives
with `deltaX` exactly 0 — only its sideways swipe carries a horizontal delta.
The audit that produced the bridge simulated a trackpad by setting `deltaX` by
hand and never drove a physical one, so the assumption went unchallenged until
the merged build reached a Mac: an ordinary vertical scroll pushed the board
sideways.

Confirmed in a real browser against the running app. On this Mac, twelve
vertical notches now leave `scrollLeft` at 0 while a horizontal delta still
drives the board to 360. With `navigator.platform` spoofed to `Win32` through
`page.addInitScript`, the same twelve notches move it 0 → 572, and a single
horizontal delta afterwards switches the bridge off so the next twelve leave it
at 0.

## Decision

`installHorizontalWheelBridge` keeps a per-install `hasHorizontalAxis` flag. It
starts `true` on macOS, which ships a trackpad, and is set `true` for good the
first time any wheel event carries a non-zero `deltaX`. While it is `true`
nothing is intercepted. Everything else about the bridge — the
vertically-scrollable-ancestor rule and `WHEEL_X_SELECTOR` — is unchanged.

## Risks

A Mac driven by a plain mouse gets no bridge, and neither does a Windows or
Linux machine after its touchpad has been used once in that session, even if the
user later switches to a mouse without reloading. Both were accepted over the
alternative: a wrong guess makes ordinary vertical scrolling drift sideways,
which is far worse than a horizontal container needing `Shift`+wheel or its
scrollbar.

## Alternatives considered

Fingerprinting the device from the delta itself — integer multiples of 120 for a
mouse, small or fractional values for a trackpad. Rejected: a fast trackpad
flick produces large integer deltas too, so it trades a certain regression for a
probabilistic one, and a physical trackpad could not be driven here to falsify
it. Reverting the bridge outright: leaves the original bug, which is the whole
reason Windows and Linux users could not move the board at all.
