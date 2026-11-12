> Revised on 2026-11-09: `decisions/2026/11/09/revert-inline-completion-offers-to-modal.md` reverted this together with the inline completion offers, then only the anchored popover for the user's own click was restored, and later the same day narrowed to the Active Tasks sidebar: the maintainer wants the modal everywhere else. The open-task path through `TaskCompletionStrip` described in the original is gone; that case uses the modal.

# The user's own Complete/Cancel confirms where they clicked


## Context

After `completion-offers-render-inline-not-modal`, merge and agent completion offers render on the task, but the user's own Complete/Cancel (card ✓, sidebar row, Activity row, inspector ✓, menu and palette) still opened the centred `confirm()` modal over a dimmed app. That modal blocks the whole board for a choice about one task the user just pointed at.

## Decision

`confirmTaskCompletion` picks the surface for the one-click path (`alwaysConfirm`). With a connected `anchor` (the clicked ✓ or Cancel on an Active Tasks sidebar row, passed through `moveTaskToStatus`; board cards and Activity rows pass none) it calls `confirm({ anchor })`, which renders the same dialog as a popover beside the anchor with no dim layer (`placeBesideAnchor` in `confirm.tsx`). The popover re-places itself when it resizes, because the deferred unsaved-work check lands after first layout. The clicked control is disabled while the ask is open, so the focus trap has no trigger to restore; `returnFocusWhenEnabled` hands focus back to it once it is enabled again. The panel also mounts hidden until placed, and a hidden button ignores `autoFocus`, so Cancel is focused once the popover is visible. Every other ask (no anchor, merge, agent) keeps the modal. The popover keeps the full subject card, the deletion footer and the gated unsaved-work check.

## Risks

The popover still holds an invisible full-screen layer, so the first outside click only dismisses it. That is deliberate: a destructive ask must not be answered by a click meant for something else.

## Alternatives considered

A compact modal with a one-line subject removed context that the sidebar and Activity rows do not show. A new popover component would duplicate the queue, abort, deferred-check and focus logic that `confirm()` already owns.
