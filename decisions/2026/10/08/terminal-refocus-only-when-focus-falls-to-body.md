# Terminal takes focus back only when it falls to the page body

## Context

In browser mode the terminal's hidden textarea re-focuses itself 50 ms after a blur, to keep the mobile keyboard up (`TerminalView.tsx`, the `blur` listener on `hiddenTextarea`). The guard meant to skip this when another element takes focus read `document.activeElement` inside the `blur` event, where it is still `body`. So the guard never fired, and the textarea stole focus from everything. A context menu treats focus leaving it as dismissal (`useOverlayLayer`), so the sidebar's right-click menu closed about 50 ms after it opened.

## Investigation

An event log from the user's Windows Chrome showed `focusin BUTTON` (the menu's first item), then `focusout BUTTON rel=TEXTAREA` 50 ms later. Headless Chromium reproduced it only after focus was put on the hidden textarea first; a plain click on the canvas focuses the container div instead.

## Decision

The check moves into the timeout: after 50 ms, the textarea re-focuses only if `document.activeElement` is still `body` or null. This subsumes the `role="dialog"` re-check that `decisions/2026/10/09/touch-terminal-links-open-a-sheet.md` added for the terminal link sheet. Covered by the "hidden textarea keeps focus only when nothing else takes it" tests in `TerminalView.test.tsx`.

## Risks

Focus now stays on any focusable element the user moves to: a sidebar row, a button on engines that focus buttons on tap (Chrome on Android). There, typing no longer lands in the terminal until the user taps it again, and the on-screen keyboard closes. iOS Safari does not focus buttons on tap, so it keeps the old behavior.

## Alternatives considered

- Keep stealing focus, except from editable fields and overlay layers. Rejected: it keeps a rule that takes focus from controls the user chose, and breaks keyboard navigation in the sidebar.
- Skip the refocus when the blur event's `relatedTarget` is set. Rejected: reading the settled `activeElement` answers the same question without depending on that field.
