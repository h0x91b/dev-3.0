# The user's own Complete/Cancel confirms where they clicked

## Context

After `completion-offers-render-inline-not-modal`, merge and agent completion offers render on the task, but the user's own Complete/Cancel (card ✓, sidebar row, Activity row, inspector ✓, menu and palette) still opened the centred `confirm()` modal over a dimmed app. That modal blocks the whole board for a choice about one task the user just pointed at.

## Decision

`confirmTaskCompletion` picks the surface for the one-click path (`alwaysConfirm`). With a connected `anchor` (the clicked button, passed through `moveTaskToStatus`) it calls `confirm({ anchor })`, which renders the same dialog as a popover beside the anchor, with no dim layer (`placeBesideAnchor` in `confirm.tsx`). With no anchor and the task's view mounted (`isCompletionStripMounted`), it raises a `user` completion offer on `TaskCompletionStrip`: Keep open is focused, Esc keeps the task open, there is no click arming, and the offer is withdrawn when the last task view unmounts. Otherwise it keeps the modal. The popover re-places itself when it resizes (the deferred check lands after first layout). Where no terminal hosts the card, the user's ask floats from a zero-height anchor under the inspector instead of pushing the task view down, and focus goes back where it was once answered. Both new surfaces keep the full subject card, the deletion footer and the gated unsaved-work check. The user asked for this explicitly: the overview and labels are not on every surface that has a ✓.

## Risks

The popover still holds an invisible full-screen layer, so the first outside click only dismisses it. That is deliberate: a destructive ask must not be answered by a click meant for something else. Card and sidebar markers skip `user` offers (`pickCompletionOffer(..., unsolicitedOnly)`), so they still mean "something is waiting for you".

## Alternatives considered

A compact modal with a one-line subject removed context that the sidebar and Activity rows do not show. Using the strip for every surface fails off the task, because the strip is not mounted there. A new popover component would duplicate the queue, abort, deferred-check and focus logic that `confirm()` already owns.
