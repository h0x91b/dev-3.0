# Terminal reclaims focus from its own container

## Context

`decisions/2026/10/08/terminal-refocus-only-when-focus-falls-to-body.md` made the browser-mode hidden textarea re-focus after a blur only when focus settled on `body` or nowhere. That rule also treated the terminal's own container as "someone else": ghostty's `term.focus()` and its canvas `mousedown` both focus the container, which carries `inputmode="none"` so it never summons the on-screen keyboard. In touch raw mode, closing terminal search or the copy-mode recovery paths (each calls `term.focus()`) would leave focus there and hide the keyboard; before that PR the textarea always took it back.

## Investigation

In headless Chromium on the 2026-10-08 build, focusing the container from the textarea or clicking the canvas left `document.activeElement` on the container 120 ms later. Hardware typing still worked, because ghostty's `keydown` listener sits on the container. The on-screen keyboard effect was not checked on a device; it follows from `inputmode="none"`.

## Decision

The 50 ms timeout in the `blur` listener on `hiddenTextarea` (`TerminalView.tsx`) also re-focuses when `document.activeElement` is `containerRef.current`. Focus on anything outside the terminal (menus, inputs, dialogs) is still left alone. Covered by "takes focus back from its own container" in `TerminalView.test.tsx`.

## Risks

On desktop browsers focus now ends on the textarea instead of the container after a canvas click. Both receive keystrokes (the textarea's events bubble to ghostty's container listeners), so typing is unchanged; the textarea's own `beforeinput`/`input` handlers now see desktop input too, as they did before 2026-10-08.

## Alternatives considered

- Call `hiddenTextarea.focus()` at every `term.focus()` site in browser mode. Rejected: six call sites plus ghostty's internal canvas handler, which we do not own.
- Drop `inputmode="none"` from the container. Rejected: the keyboard would then pop up on every task open (see the comment where it is set).
