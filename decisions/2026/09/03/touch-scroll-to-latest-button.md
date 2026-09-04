# Touch scroll-to-latest: a conditional floating button, driven by a copy-mode poll

## Context

On a phone the terminal runs in compose mode: a tap on the canvas must not summon the
keyboard, so `TerminalView.handleTerminalClick` returns early — and with it the click that
leaves tmux copy-mode on desktop. Once a swipe scrolled the pane into history, the only ways
back were swiping the whole history down or leaving the task. dev3 had no scroll-to-bottom
control at all; the `[280/1699]` badge users took for one is tmux's own copy-mode position.

## Investigation

The renderer knows when a pane *may* have entered copy-mode (`tmuxCopyModeMayBeActiveRef`, set
on wheel-up and on a drag), but never learns when tmux left it by itself: the default
`WheelUpPane` binding is `copy-mode -e`, which exits on scrolling past the bottom, and nothing
in the PTY stream announces that. ghostty's own scrollback (native backend) does announce
itself via `onScroll` / `viewportY`. Seven placements were mocked over a real 390px screenshot;
the user picked the round accent button (option B) over a labelled pill, a strip above the
status line, and slots in the key bar, composer row, or pane bar.

## Decision

`ScrollToLatestButton` renders in `TaskTerminal` / `ProjectTerminal` only while `touchInput`
holds and `TerminalView` reports `onScrolledIntoHistory(true)`. The tmux signal is the existing
flag plus a 1.5 s poll of a new read-only RPC, `tmuxPanesInMode` (`pane_in_mode` over the task
session), which lowers the flag when tmux already left copy-mode. `TerminalHandle.scrollToBottom`
does both backends: `exitCopyModeAllPanes` and ghostty `scrollToBottom()`. `paste` / `submit`
call the same exit first when the flag is up, so a composer prompt never lands in copy-mode.

## Risks

The flag is a guess: a wheel-up inside a mouse-tracking TUI (vim, htop) never enters copy-mode,
so the button shows for up to one poll tick before the poll clears it. The poll runs only while
the flag is up, so an idle terminal costs nothing. The button covers ~2 rows of the canvas's
bottom-right while visible — accepted, since it exists only while the tail is off-screen anyway.

## Alternatives considered

A permanent key in `ExtraKeyBar` or a fifth composer icon (chrome for a state that is usually
absent; both rows are at their narrow budget). A full-width strip above the status line (the
viewer-bar pattern; costs a band of screen). Parsing tmux's status line for the position badge
(brittle across themes). A tmux `after-copy-mode` hook (tmux has no exit hook for copy-mode).
