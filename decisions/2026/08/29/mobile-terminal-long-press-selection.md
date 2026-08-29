# Long-press, not horizontal drag, selects terminal text on touch

## Context

On a phone there was no way to copy a specific piece of terminal output. iOS's own
long-press landed on the container ghostty-web marks `contenteditable="true"`, and with
no text inside it (the glyphs live in a canvas) WebKit selected the whole editable block
— the entire terminal highlighted, with a callout that copies nothing. The app's only
selection trigger was a horizontal drag in raw mode, which is also the pane-swipe
gesture, and compose mode — the default on mobile — disabled it outright.

## Investigation

Reproduced in a phone-sized browser session with `navigator.maxTouchPoints` forced on:
the terminal container carries `contenteditable="true"`, `inputmode="none"` and
`-webkit-user-select: auto`. Compose mode additionally stops `mousedown`/`mouseup`/
`click`/`touchend` in the capture phase on that container, so no synthetic mouse event
can reach the canvas — which is why selection was raw-mode only.

## Decision

Two changes in [`TerminalView.tsx`](../../../../src/mainview/TerminalView.tsx)'s setup:
the container gets `user-select: none` + `-webkit-touch-callout: none` in browser mode
(the hidden IME textarea is exempted), and a 450 ms hold on a still finger anchors a
selection (`mousedown` at the touch point) that the drag extends and the release ends.
It replaces the horizontal-drag trigger entirely and works in both modes: a
`touchSelecting` flag lets that one drag's synthetic mouse events past the compose-mode
blocker. The canvas carries `data-selecting="1"` while it runs, which is how
[`MobilePaneCarousel`](../../../../src/mainview/components/MobilePaneCarousel.tsx) knows
to leave a horizontal selection drag alone — its nascent-selection collapse hack is gone
with the trigger it existed for.

Downstream copy is unchanged: with tmux mouse tracking on the drag becomes SGR mouse
reports and `copy-pipe-and-cancel` returns the text over OSC 52; without it ghostty's own
selection feeds the existing `copyTerminalSelection` bridge.

## Risks

The 450 ms hold is a hidden gesture with no on-screen affordance (`ask-dev3` documents
it). `-webkit-touch-callout` is WebKit-only and silently dropped by Chromium, so it can
only be verified on a real iOS device; `user-select: none` alone already suppresses the
block selection there. A hold that starts on the wrong cell has no handles to adjust it —
the user lifts and holds again.

## Alternatives considered

Keeping the horizontal-drag trigger alongside the long press — rejected: it competes with
the pane swipe for the same gesture, which is what the carousel's collapse hack existed to
paper over. A dedicated "select mode" toggle in the extra-key bar — rejected: another
button on a bar that is already full, for something a long press expresses natively.
