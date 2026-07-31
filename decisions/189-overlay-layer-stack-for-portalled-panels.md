# 189 — An overlay-layer stack for portalled panels

## Context

Every anchored panel in the launch flow — `Select`'s dropdown, `FavoritesMenu`,
`AgentAccountIndicator`'s account switcher — renders through
`createPortal(…, document.body)` so it is never clipped by the dialog or the
variant card it belongs to. That portal broke two things at once, and each
component had been solving (or not solving) them on its own:

1. **Tab could not reach the panel.** `useFocusTrap` collects focusables from the
   dialog container's subtree. A portalled panel is a *sibling* of that
   container, so the trap pulled focus straight back into the dialog. Verified in
   a browser: with the account popover open, Tab from its trigger landed on the
   Model select. Not one option in Provider / Model / Mode / Favorites / Account
   was reachable without a mouse.
2. **Escape closed the wrong thing.** `useEscapeKey` is capture-phase plus
   `stopImmediatePropagation`, so the listener registered *first* wins — and a
   modal always mounts before the popover inside it. Escape with a dropdown open
   therefore destroyed the whole Launch dialog and the configuration in it.
   `FavoritesMenu` was the only panel that had worked around this, via a
   hand-rolled capture-phase listener in its parent picker.

## Decision

`src/mainview/utils/overlay-layers.ts` owns an ordered stack of open portalled
panels. `useOverlayLayer(panelRef, { onDismiss, triggerRef, autoFocus })`
registers one; `useFocusTrap` unions the stack's elements into its Tab ring and
its "inside" test, and `useEscapeKey` calls `dismissTopOverlayLayer()` before
closing itself. The stack keeps its own capture-phase listener for panels opened
with no surrounding modal (the account pill in Settings).

A panel that registers must **not** also call `useEscapeKey` — that is the one
rule. In exchange it gets keyboard reachability, innermost-first Escape, and
close-on-focus-leave for free, and the per-component staging hacks are gone
(`AgentConfigPicker` lost its Escape effect entirely).

## Risks

The stack is module-global mutable state, so a panel that unmounts without
running its cleanup would strand an entry and swallow Escape. `useOverlayLayer`
unregisters in the effect teardown, which React always runs, so this needs a
thrown error inside cleanup to happen.

`useFocusTrap` now reads the stack on every Tab. The stack is at most 1–2 entries
deep in practice, so the cost is a `flatMap` over two `querySelectorAll` results.

Panels are ordered by registration, not by DOM nesting. Two sibling panels open
at once would resolve Escape by open order — correct for the nesting we have
(trigger inside a dialog), untested for genuinely parallel panels.

## Alternatives considered

**Portal into the dialog element instead of `document.body`.** Fixes focus and
Escape for free, but reintroduces the clipping the portal exists to avoid: the
variant card is `overflow-hidden` and the modal body scrolls at `max-h-[50vh]`.

**Keep per-component staging.** What `AgentConfigPicker` did for `FavoritesMenu`
— a capture-phase listener in the parent, gated on the child's open state. It
works, but it is O(panels × parents) to write, it was already missing on two of
three panels, and it does nothing about the focus half of the problem.

**A native `<dialog popover>` / the Popover API.** The right long-term answer for
top-layer rendering, but it changes stacking, backdrop and dismissal semantics
across every existing dialog in the app — too wide for this change.
