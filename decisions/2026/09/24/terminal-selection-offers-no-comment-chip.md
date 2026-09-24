# A terminal selection copies and offers nothing else

## Context

`review-comments-on-the-task-record` (2026-09-16) made the terminal's select-to-copy gesture
also pop a six-second `Comment` chip over the selected text, from both the ghostty selection
bridge and the tmux OSC 52 path. Selecting terminal output is one of the most frequent gestures
in the app, almost always just to copy, and several users reported the chip as intrusive.

## Decision

The chip, its inline composer and the `canComment` prop are deleted from `TerminalView.tsx`;
`TaskTerminal.tsx` no longer opts in. Copying, tmux copy mode and every other review surface
(diff, file preview, image, artifact) are untouched. The `terminal-text` anchor stays in
`src/shared/review.ts`: comments already stored on tasks keep rendering and sending.
`TerminalView.test.tsx` asserts that both selection paths copy and draw no new control.

## Risks

- There is no way left to create a `terminal-text` comment. Users who liked it lose it until a
  deliberate entry point exists.

## Alternatives considered

- **Keep the chip behind a setting:** no such setting existed, and adding one was out of scope.
- **Show it only on a modifier-drag:** under tmux mouse mode the drag belongs to tmux, and Option
  or Shift change what tmux and the terminal do with it, so the gesture would be unreliable and
  undiscoverable.
- **Stop passing `canComment` and keep the code:** leaves a dead branch nobody can reach.
- **An explicit action (context menu / shortcut on the selection):** a new action, which needs a
  `/ux-principal` placement pass first; overlaps the terminal context-menu work in flight.
