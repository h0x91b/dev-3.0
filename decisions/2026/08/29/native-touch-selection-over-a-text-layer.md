# Touch selection is the platform's, over a real-DOM text layer

## Context

On a phone there was no way to copy a specific piece of terminal output. iOS's
long-press landed on the container ghostty-web marks `contenteditable="true"`, and
with no text inside it (the glyphs live in a canvas) WebKit selected the whole
editable block — the entire terminal highlighted, and Copy putting a multi-megabyte
`.webarchive` of the page on the pasteboard rather than any text. The only selection
trigger the app had was a horizontal drag in raw mode, which is also the pane-swipe
gesture, and compose mode — the default on mobile — disabled it outright.

## Investigation

A first pass replaced the horizontal drag with a 450 ms long press that anchored a
ghostty/tmux selection and copied on release. It worked — verified end to end, the
dragged range landed in the tmux paste buffer — but it produced no grab handles, no
magnifier and no Copy menu, because none of that is ours to draw: iOS renders its
selection UI only for genuine text nodes, never over a canvas. The gesture was
correct and the affordance was still missing, which is the half users actually
recognise.

## Decision

Stop implementing selection. Give the platform something real to select instead:
[`terminal-touch-text-layer.ts`](../../../../src/mainview/terminal-touch-text-layer.ts)
lays a transparent copy of the visible rows over the canvas, installed in browser
mode when the PRIMARY pointer is coarse — `matchMedia("(pointer: coarse)")`, not
`navigator.maxTouchPoints > 0`. The layer is what a pointer lands on, so gating on
mere touch support would install it on a touchscreen laptop and take every mouse
click away from ghostty. iOS and Android then run their own
selection — handles, magnifier, Copy / Look Up / Share — and the copy is plain text
straight out of the DOM, with no OSC 52 round trip and no insecure-context clipboard
problem.

Three properties carry the alignment. `buffer.active.getLine(y)` indexes the WHOLE
buffer, scrollback included — screen row 0 is `wasmTerm.getScrollbackLength()`, not 0 —
so the layer resolves a screen row exactly the way ghostty resolves a click into one:
`scrollbackLength - max(0, floor(viewportY)) + row`. Reading from 0 instead put the
oldest lines the session ever printed under the user's finger, perfectly aligned and
completely wrong, which is invisible until you tint the layer and look. `lineToText` (already in
[`terminal-file-links.ts`](../../../../src/mainview/terminal-file-links.ts)) emits one
UTF-16 unit per cell, so string index === screen column. And `letter-spacing` is
re-tuned on every refresh to `charWidth - measuredAdvance`, so a character advances by
exactly one cell whatever the font measures. The layer refreshes from the render
guard's `onFrame` (ghostty-web never fires `onRender`), coalesced to one rebuild per
animation frame, and skips entirely while a selection is live so output cannot collapse
it. Because the layer is on top, it — not the canvas — is what a finger lands on, so
the scroll/tap gestures in [`TerminalView.tsx`](../../../../src/mainview/TerminalView.tsx)
now listen there and stand down whenever a selection touches the layer;
`MobilePaneCarousel` asks the same question so a handle drag never swipes panes.
Both ask `selectionTouches()` **synchronously** rather than reading a flag kept by a
`selectionchange` listener: Blink dispatches that event on a task, so a cached answer
is stale for exactly the frames in which the user is starting a drag — long enough to
synthesize a scroll under their handles. The range test is `intersectsNode`, not
`contains`, because a range the browser anchored at a parent still covers our rows and
must not read as "no selection".

## Android: the platform selects, but offers no way to act on it

Verified on a Chrome 124 emulator driven through `adb`: Android does the selecting
correctly — word select, handles, and a handle drag that extends the range exactly —
but never draws its floating Copy toolbar over these rows, so the user ends up holding
a perfect selection with nothing to do with it. A plain `<pre>` in the same browser
gets the toolbar immediately, so it is this page, not the browser.

Four candidates were eliminated by experiment: `touch-action: none` (selection and
drag both work with it), fullscreen, the canvas repainting every frame, and the
container's `contenteditable` alone. The layer now carries `contenteditable="false"`
— a non-editable island inside ghostty's editable container, which is semantically
right for rows that are not editable text and leaves ghostty's focus and IME
untouched — and that restores Chrome's selection-context UI, but still not the toolbar.

So the toolbar is not what we depend on. dev3 already answers this everywhere else:
selecting IS copying (`terminal.copyHint`). The layer emits a settled selection 250ms
after the last change — a handle drag fires dozens of changes and each one would
otherwise be a clipboard write — and `TerminalView` copies it with
`writeClipboardText`. Deliberately NOT `copyTerminalSelection`: that RPC writes the
HOST's clipboard, which is the wrong machine when the terminal is being read on a
phone. No new control, so no complexity-budget spend and no second model for an
action the product already has.

Verified end to end on the emulator: long-press a word, then Android's own
`KEYCODE_PASTE` into the composer returns that word. Remote mode is plain http, so
`navigator.clipboard` does not exist and the copy runs through the documented
`execCommand` fallback — which is the path this actually exercises.

## Risks

The platform's selection UI cannot be reproduced in a headless browser, and neither
can a coarse pointer (Playwright's device emulation still reports `pointer: fine`),
so both the callout and the gate that admits it are only verifiable on a device — the tests cover the layer's content, geometry,
selection-safety and the gesture stand-down, not the callout itself. Only the visible
viewport is in the DOM, so a selection cannot run off-screen into scrollback: scroll
first, then select. The layer carries logical text, so a bidi viewport selects in
logical rather than visual order. Alignment leans on the font measuring the same way
for `measureText` as it does for ghostty's `charWidth`; a fallback font that does not
would drift across a wide row. On Android the copy rides `execCommand` because remote
mode is not a secure context; if a browser drops that fallback the copy goes with it.
Only Chrome was testable — Samsung Internet is unverified. Font size and family are both live settings, so the
layer re-reads them from `term.options` on every refresh rather than capturing them —
a stale family measures a different advance than ghostty draws with.

## Alternatives considered

The long-press gesture from the first pass, kept as-is — rejected: it is the
mechanism, not the affordance, and the missing handles and Copy menu were the actual
complaint. Drawing our own handles and a Copy bubble in React — rejected as the
user's explicit call: it is fully verifiable headlessly and consistent across
platforms, but never feels native and gives up the magnifier, Look Up and Share for
free. Keeping both the gesture and the layer — rejected: two selection mechanisms on
one long press fight each other, and the gesture survives in git if the layer fails
on a real device.
