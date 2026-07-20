# 139 — Keep tmux copy-mode after mouse copy

## Context

Mouse-drag copying older terminal output cleared the selection as expected, but also jumped the viewport to live output. The affected path copies through tmux and OSC 52, not through Ghostty's native selection clipboard.

## Investigation

Both tmux copy-mode tables default `MouseDragEnd1Pane` to `copy-pipe-and-cancel`. An isolated tmux reproduction showed that command changing `pane_in_mode` from 1 to 0 and losing the scroll position, while `copy-selection` cleared the selection but kept copy-mode and `scroll_position` unchanged.

## Decision

Override `MouseDragEnd1Pane` in both copy-mode tables in [`TMUX_CONFIG_FUNCTIONAL`](../src/bun/tmux/config.ts) with `send-keys -X copy-selection`. `set-clipboard on` continues to deliver the copied text through OSC 52, while the viewport remains at the selected scrollback position.

[`TerminalView`](../src/mainview/TerminalView.tsx) records tmux-owned upward scrolling and drag gestures as possible copy-mode entry. The drag-generated click keeps the viewport in copy mode; the next distinct plain terminal click focuses Ghostty and invokes the existing `exitCopyModeAllPanes` RPC so live input resumes without a separate Escape press.

## Risks

Copy mode remains active after the drag until the user clicks plainly, presses Escape, or scrolls back to live output. The renderer signal is deliberately conservative: a false positive only causes the existing best-effort reset RPC to find no pane in copy mode; modifier clicks and the click emitted by the drag itself never reset the viewport.

## Alternatives considered

Preserving Ghostty's viewport around PTY writes operates above the tmux-owned scrollback and did not fix this gesture. `copy-selection-no-clear` would preserve the highlight unnecessarily, keeping `copy-pipe-and-cancel` reproduces the jump by design, and requiring Escape after every copy adds avoidable keyboard friction.
