# 011 — Shift+functional key workaround for ghostty-web

## Context

Shift+Tab, Shift+Enter, and other Shift+functional key combinations did not work inside tmux sessions. Users reported that Shift+Tab (reverse tab completion) and Shift+Enter (newline without submit) in Claude Code were broken.

## The bug in ghostty-web

ghostty-web's `InputHandler.handleKeyDown()` (in the bundled `ghostty-web.js`, around line 867) has a shortcut path for functional keys:

```javascript
// Pseudocode of the buggy path
const mods = extractModifiers(event);  // includes SHIFT
if (mods === NONE || mods === SHIFT) {
    switch (key) {
        case ENTER: send("\r"); return;     // Shift+Enter → \r (same as Enter!)
        case TAB:   send("\t"); return;     // Shift+Tab → \t (same as Tab!)
        case HOME:  send("\x1b[H"); return; // Shift+Home → same as Home
        // ... same for End, Insert, Delete, PageUp/Down, F1-F12
    }
}
// WASM KeyEncoder (which WOULD encode Shift correctly) never runs
```

The condition `mods === NONE || mods === SHIFT` means that when Shift is the only modifier held, the code takes the same shortcut as for unmodified keys. The escape sequence sent is identical — the Shift modifier is silently discarded. The WASM KeyEncoder (Ghostty's proper key encoding engine, which understands Kitty keyboard protocol and modifyOtherKeys) is never reached for these combinations.

This is a known bug: [coder/ghostty-web#109](https://github.com/coder/ghostty-web/issues/109) — filed Dec 2025, still open. The maintainer acknowledged it but no fix has been merged.

Note: Ctrl+key, Alt+key, and multi-modifier combos are NOT affected — they don't match the `mods === SHIFT` condition and correctly fall through to the WASM encoder.

## The tmux layer (Shift+Enter specifically)

Shift+Tab has a universally recognized legacy escape sequence: `\x1b[Z` (CSI Z, aka "back-tab"). tmux understands it natively — no special config needed.

Shift+Enter is harder. There is no legacy escape sequence for it. Modern terminals use one of two encodings:
- **xterm modifyOtherKeys**: `\x1b[27;2;13~` — this is what native Ghostty sends
- **CSI u (Kitty keyboard protocol)**: `\x1b[13;2u`

Both are modern formats that tmux only forwards to inner applications when `extended-keys` is enabled. Without it, tmux may silently drop or misinterpret these sequences.

For reference, this was a pain point for native Ghostty users too — see [anthropics/claude-code#1282](https://github.com/anthropics/claude-code/issues/1282) which has 22 comments of people struggling with Shift+Enter through tmux, each with different workarounds. Claude Code 2.1.0 eventually added built-in support for the modifyOtherKeys format.

## Our fix

Two changes:

### 1. Custom key handler in `TerminalView.tsx`

We use `attachCustomKeyEventHandler()` (ghostty-web's official API for intercepting keys) to catch all Shift-only functional keys BEFORE the buggy shortcut fires. The handler sends correct escape sequences directly to the WebSocket:

- Shift+Tab → `\x1b[Z` (standard back-tab)
- Shift+Enter → `\x1b[13;2u` (CSI u format)
- Shift+Home → `\x1b[1;2H`, Shift+End → `\x1b[1;2F`, etc. (xterm-style `;2` modifier)
- Shift+F1-F12 → xterm-style modified function key sequences

The handler returns `true` to stop ghostty-web from processing the event further.

### 2. tmux config: `set -s extended-keys always`

Added to the `TMUX_CONFIG` in `pty-server.ts`. This tells tmux to always forward extended key sequences (CSI u format) to inner applications. The `always` variant was chosen over `on` because `on` requires the outer terminal to respond to capability queries — and ghostty-web running through a Bun PTY may not respond correctly to tmux's `\x1b[?u` probe.

## Risks

- **`extended-keys always`** makes tmux send extended key sequences to ALL inner applications, even if they didn't request them. Modern CLI tools (Claude Code, vim, etc.) handle this fine. Very old tools that don't understand CSI u sequences might display garbage, but this is unlikely in practice.
- **CSI u vs modifyOtherKeys for Shift+Enter**: We send `\x1b[13;2u` (CSI u). Native Ghostty sends `\x1b[27;2;13~` (modifyOtherKeys). Claude Code 2.1.0+ recognizes both. If an inner app only recognizes one format, Shift+Enter might not work for that specific app.
- **If ghostty-web fixes the bug upstream**, our handler is harmless — it fires first and sends the same sequences the fixed encoder would produce. No conflict.

## Alternatives considered

- **Patching/forking ghostty-web**: Rejected. Maintaining a fork is expensive. The `attachCustomKeyEventHandler` API is the intended extension point.
- **Sending `\x1b\r` (ESC+CR) for Shift+Enter**: Some users in the claude-code#1282 thread used this as a tmux workaround. It works but is ambiguous (could be interpreted as Alt+Enter) and doesn't follow any standard encoding.
- **`extended-keys on` instead of `always`**: Safer but requires the outer terminal to negotiate capabilities. Our outer terminal (ghostty-web → Bun PTY) may not respond to tmux's queries, causing tmux to never enable extended keys.

## Key files

- `src/mainview/TerminalView.tsx` — `SHIFT_KEY_SEQUENCES` map + `attachCustomKeyEventHandler`
- `src/bun/pty-server.ts` — `TMUX_CONFIG` constant (`extended-keys always`)

## References

- [coder/ghostty-web#109](https://github.com/coder/ghostty-web/issues/109) — the upstream bug report (Shift+Tab + Alt+key on macOS)
- [anthropics/claude-code#1282](https://github.com/anthropics/claude-code/issues/1282) — Shift+Enter in Ghostty + tmux discussion (22 comments of workarounds)
- [anthropics/claude-code#5757](https://github.com/anthropics/claude-code/issues/5757) — original Shift+Enter bug report for native Ghostty
