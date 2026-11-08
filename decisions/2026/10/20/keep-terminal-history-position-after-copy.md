# Keep terminal history position after copying

Extended on 2026-11-08 by `decisions/2026/11/08/keep-history-position-after-multi-click-copy.md`: double- and triple-click selections follow the same rule, and a plain click waits out tmux's double-click window before it leaves history.

## Context

`MouseDragEnd1Pane` used `copy-pipe-and-cancel`, so selecting older output copied text and immediately returned to live output. PR #991 previously tried retaining copy-mode and was reverted in #1013 because subsequent input remained trapped in history; see `decisions/2026/07/20/revert-tmux-copy-mode-after-copy.md`.

## Investigation

A real tmux/Ghostty test reproduces the jump after a successful OSC 52 copy. Ghostty emits encoded keys and automatic terminal responses through the same `onData` callback, so cancelling on every outgoing message would also abandon history during mouse selection or terminal queries. Its custom key handler runs before key encoding and `onData`.

## Decision

Both tmux copy-mode tables use `copy-pipe` when `scroll_position` is positive and `copy-pipe-and-cancel` at the live tail, preserving OSC 52 and a scrolled viewport without leaving live-screen copies in a mode that holds agent input. In `TerminalView`, ordinary text/IME input, paste and attachment paths leave copy-mode before sending bytes; cancel keys, navigation, modifiers and copy shortcuts stay with tmux. Bytes without a key event (the touch extra-key bar's Esc, Ctrl and arrows) get the same split, through `terminal-history-input.ts`. Once a history command takes keyboard control, subsequent text and Enter also stay with tmux, including search prompts, until a new mouse gesture or explicit click/paste resumes input. tmux picks `mode-keys vi` itself when the server's `EDITOR`/`VISUAL` contains "vi", and there letters are history commands: an exit requested for a typed key (`exitCopyModeAllPanes` with `typedKey`) leaves copy-mode-vi panes in place (`panesKept`), and the renderer stays in history. A fresh tmux stream and returning window focus account for inherited mode after fullscreen remounts or another viewer, with at most one cancellation round trip and no per-key polling.

## Risks

Copy-mode exit is an asynchronous RPC: the first key waits for it, and overlapping keys share the existing pending promise to preserve order. Deliberately scrolled history still defers agent deliveries under the existing policy; live-screen copying exits immediately, and delivery code is unchanged. Real tmux tests cover OSC 52, live-copy exit, retained history position, cancel keys consumed without application input, and resumed typing/paste; renderer tests cover ordering, history search input, extra-key cancel bytes and kept copy-mode-vi panes. The printable-key split follows tmux's default tables; custom copy-mode bindings in a user's own tmux config are not consulted.

## Alternatives considered

Retaining copy-mode without handling subsequent input repeats #1013's regression. Cancelling and reconstructing the viewport would race live output and other viewers. Replacing tmux selection with a separate renderer selection model is larger than retaining the existing clipboard path.
