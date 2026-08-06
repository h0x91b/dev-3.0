# 145 — Revert keeping tmux copy-mode after mouse copy

## Context

Decision 139 (PR #991, issue #978) overrode `MouseDragEnd1Pane` in both tmux copy-mode tables with `send-keys -X copy-selection` so a mouse-drag copy of scrollback kept the viewport in place instead of jumping to live output. In practice this made copy-mode sticky: after any mouse copy the pane stayed in tmux scroll mode, so clicks landed as copy-mode gestures (cursor jumping to random cells) and the user had to press Escape constantly — especially disruptive in Codex sessions.

## Decision

Reverted the two `MouseDragEnd1Pane` overrides in [`TMUX_CONFIG_FUNCTIONAL`](../src/bun/tmux/config.ts) and dropped the matching regression test in `config.test.ts`. `MouseDragEnd1Pane` returns to tmux's default `copy-pipe-and-cancel`: the copy still reaches the clipboard via `set -s set-clipboard on` (OSC 52), and copy-mode is cancelled immediately so the terminal is live again with no Escape. Issue #978 is reopened to be solved a different way.

## Risks

The original #978 symptom returns: mouse-copying older scrollback snaps the viewport to live output. Accepted as the lesser evil versus sticky copy-mode. The renderer safeguards from PR #1004 (`TerminalView` copy-mode tracking + click-to-exit, and the Diff→terminal focus restore in `TaskWorkspacePane`) are intentionally kept: the Diff focus fix is independent, and the click-to-exit path is now largely inert for mouse copy (best-effort `exitCopyModeAllPanes` finds no pane in copy-mode) but still cleanly returns to live input after wheel-scrolling into scrollback.

## Alternatives considered

Rewriting #1004's click-to-exit heuristic to fully mask the viewport jump — rejected: it never made copy-mode transparent enough and added keyboard friction. Removing #1004's renderer logic too — rejected: the Diff focus fix is unrelated and valuable, and the copy-mode tracking is harmless. A viewport-preserving fix above tmux (Ghostty selection clipboard) is the likely path for the reopened #978.
