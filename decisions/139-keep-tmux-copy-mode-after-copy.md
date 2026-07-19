# 139 — Keep tmux copy-mode after mouse copy

## Context

Mouse-drag copying older terminal output cleared the selection as expected, but also jumped the viewport to live output. The affected path copies through tmux and OSC 52, not through Ghostty's native selection clipboard.

## Investigation

Both tmux copy-mode tables default `MouseDragEnd1Pane` to `copy-pipe-and-cancel`. An isolated tmux reproduction showed that command changing `pane_in_mode` from 1 to 0 and losing the scroll position, while `copy-selection` cleared the selection but kept copy-mode and `scroll_position` unchanged.

## Decision

Override `MouseDragEnd1Pane` in both copy-mode tables in [`src/bun/tmux/config.ts`](../src/bun/tmux/config.ts) with `send-keys -X copy-selection`. `set-clipboard on` continues to deliver the copied text through OSC 52, while the viewport remains at the selected scrollback position.

## Risks

Mouse copying now leaves the pane in copy-mode, so the user must press Escape or scroll back to live output when finished reading history. Keyboard copy bindings and copying at the live terminal are unchanged.

## Alternatives considered

Preserving Ghostty's viewport around PTY writes operates above the tmux-owned scrollback and did not fix this gesture. `copy-selection-no-clear` would preserve the highlight unnecessarily, and keeping `copy-pipe-and-cancel` reproduces the jump by design.
