# One owner per screen corner

## Context

The update-ready prompt (`GlobalHeader`) and the toast stack (`ToastHost`) both positioned
themselves at `fixed top-14 right-4`. Two independent stacks at one anchor cannot know how
tall the other is, so they simply landed on top of each other: the toast host's `z-[55]`
covered the prompt's `z-50`, hiding its version header, its close button, and — with two
toasts on screen — its Restart button.

## Investigation

Raising or swapping z-indexes cannot fix this: whichever wins covers the loser. The corner
already had a working precedent in the codebase — `StatusDock` owns the bottom-left corner
so that two independent remote status pills cannot overlap, and declares its safe-area
insets once.

## Decision

`ToastHost` (`src/mainview/toast.tsx`) is the single owner of the top-right corner. It
always renders its fixed column now — even with an empty stack — and exposes a pinned slot
above the toasts through `usePinnedToastSlot()`. The update prompt portals into that slot
instead of positioning itself (`GlobalHeader.tsx`), gets the toast card's width for a shared
trailing edge, and is separated from the transient pile by twice the intra-group gap
(`gap-5` outer, `gap-2.5` inner) so the two read as "a decision waiting for you" and "things
that just happened".

The prompt goes above the toasts because it is not a toast: it never expires, is never
evicted by capacity, and carries a restart deadline.

`src/bun/__tests__/one-owner-per-screen-corner.test.ts` scans the renderer for `fixed` +
vertical + horizontal edge class combinations and fails when two files claim one corner.
Verified by mutation: restoring the old `fixed top-14 right-4` on the prompt fails both
assertions.

## Risks

The prompt is invisible if `ToastHost` is not mounted. It is mounted unconditionally in
`App.tsx`, and there is deliberately no fallback to a second fixed position — that fallback
would be the bug. Tests that render the header without a host must mock
`usePinnedToastSlot`; two suites do.

## Alternatives considered

- **Separate corners** — the prompt to bottom-right. Cheap, but adds a third floating zone
  and puts the auto-restart countdown where nobody looks.
- **Drop the auto-shown prompt** and pulse a header chip with the countdown instead. Quietest
  option, but a five-minute unattended restart deserves more than a chip.
- **Suppress toasts while the prompt is up.** The toast feed is how agent activity reaches the
  user; muting it loses information.
