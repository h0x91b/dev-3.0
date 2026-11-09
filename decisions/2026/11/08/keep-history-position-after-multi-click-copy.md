# Keep terminal history position after a double- or triple-click copy

## Context

`decisions/2026/10/20/keep-terminal-history-position-after-copy.md` made a mouse-drag copy keep a scrolled history viewport, which covered the gesture named in h0x91b/dev-3.0#978 but not the other two mouse selections. Double-clicking a word or triple-clicking a line in history still snapped the terminal to live output, and it copied the wrong text: whatever sat under the pointer on the live screen.

## Investigation

Reproduced on a real tmux 3.6a server through an attached client. Two independent causes stack. tmux's default `DoubleClick1Pane` and `TripleClick1Pane` bindings in both copy-mode tables end in `copy-pipe-and-cancel`, so the copy itself leaves history. Before that even runs, `TerminalView`'s plain-click handler has already called `exitCopyModeAllPanes` for the first click, so the second press reaches a pane that is no longer in copy-mode and the root-table binding selects on the live screen. tmux decides a double-click when a second press arrives within `KEYC_CLICK_TIMEOUT` (300 ms) of the first and reports it only after that window closes; it has no event for "this click stayed single".

## Decision

`TMUX_CONFIG_FUNCTIONAL` (`src/bun/tmux/config.ts`) binds `DoubleClick1Pane` and `TripleClick1Pane` in `copy-mode` and `copy-mode-vi` to the default selection followed by the same `scroll_position` test the drag binding uses: `copy-pipe` in history, `copy-pipe-and-cancel` at the live tail. In `TerminalView`, `handleTerminalPress` records every primary press and `handleTerminalClick` leaves history only for a click whose press did not follow another one inside `TMUX_MULTI_CLICK_MS`, and only once that window has passed since the press; a new press cancels a pending exit. Typing, paste and dropped paths still leave history immediately through their own paths.

## Risks

A plain click now returns to live output up to 350 ms after the press instead of at once; typed text is not delayed. The renderer and tmux time the same presses on two clocks, so `TMUX_MULTI_CLICK_MS` carries 50 ms of slack: a pair of presses 300–350 ms apart keeps history without selecting anything, and the next click leaves it. The explicit bindings override a user-side rebinding of those keys, as the drag binding already does. Reverting this means pinning tmux's defaults explicitly, not deleting the lines: a deleted `bind` stays in effect on a running server (`decisions/2026/07/20/insecure-context-clipboard-and-stale-tmux-binds.md`). Covered by `config.test.ts`, the real-tmux case in `paste-after-remount-e2e.test.ts` (word and line copied from the history row, viewport unchanged) and the click-timing cases in `TerminalView.test.tsx`.

## Alternatives considered

Dropping click-to-resume entirely is simpler but brings back the sticky copy-mode that got #991 reverted in #1013. Leaving history on the first click and restoring the viewport on the second races live output, the reason the 2026-10-20 record rejected reconstruction. Counting clicks inside tmux with a user option and `run-shell -d` keeps the renderer unchanged but cannot be unit-tested and lingers on running servers. Reading `event.detail` instead of timing presses follows the OS double-click interval, which differs from tmux's fixed 300 ms.
