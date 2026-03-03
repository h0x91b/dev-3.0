# 011 — Shift+functional key workaround for ghostty-web

## Context

Shift+Tab, Shift+Enter, and other Shift+functional key combinations did not work inside tmux sessions. Users reported that Shift+Tab (reverse tab completion) and Shift+Enter (newline without submit) in Claude Code were broken.

## Investigation

ghostty-web's `InputHandler.handleKeyDown()` has a shortcut path (around line 867 of the bundled JS) that matches when modifiers are `NONE` or `SHIFT`. For functional keys (Enter, Tab, Backspace, Escape, Home, End, Insert, Delete, PageUp/Down, F1-F12), it sends the unmodified escape sequence and returns early — the WASM KeyEncoder never runs. This means Shift+Tab sends `\t` (same as Tab) and Shift+Enter sends `\r` (same as Enter).

## Decision

Since ghostty-web is an npm dependency we can't patch, we use `attachCustomKeyEventHandler` in `TerminalView.tsx` to intercept all Shift-only functional keys before ghostty-web's buggy shortcut fires. The handler sends correct xterm-style escape sequences directly to the WebSocket. Additionally, `set -s extended-keys always` was added to the tmux config so tmux forwards CSI u sequences (needed for Shift+Enter) to inner applications.

Key files: `src/mainview/TerminalView.tsx` (`SHIFT_KEY_SEQUENCES` map + handler), `src/bun/pty-server.ts` (`TMUX_CONFIG`).

## Risks

The custom handler only covers Shift-alone combinations (no Ctrl, Alt, Meta). Ctrl+Shift combos fall through to the WASM encoder which handles them correctly. If ghostty-web fixes this bug upstream, the handler is harmless (it fires first and sends the same sequences the encoder would). The `extended-keys always` tmux setting could theoretically confuse very old terminal applications, but modern tools handle unknown sequences gracefully.

## Alternatives considered

Forking or patching ghostty-web was rejected — maintaining a fork is expensive and the workaround via `attachCustomKeyEventHandler` is clean and self-contained. Using `extended-keys on` (instead of `always`) was considered but rejected because it requires the outer terminal to respond to capability queries, which ghostty-web through a Bun PTY may not do reliably.
