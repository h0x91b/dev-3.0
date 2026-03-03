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

## The Shift+Enter problem: two separate layers

### Layer 1: ghostty-web swallows the modifier

ghostty-web's shortcut sends `\r` (CR) for both Enter and Shift+Enter. Our custom key handler intercepts Shift+Enter before this shortcut fires.

### Layer 2: what to actually send for Shift+Enter

This turned out to be the harder problem. There is no universally agreed escape sequence for Shift+Enter. We tried three encodings before finding what works:

| Encoding | Sequence | Result through tmux → Claude Code |
|---|---|---|
| CSI u (Kitty) | `\x1b[13;2u` | Silent failure — tmux's CSI parser doesn't recognize the `u` final byte without explicit CSI u input mode. The sequence is discarded. |
| modifyOtherKeys | `\x1b[27;2;13~` | Passes through tmux but Claude Code displays it as literal text `[27;2;13~`. Claude Code 2.1.0 added native recognition of this format, but only for detected terminal types (Ghostty, Kitty, etc.). Inside tmux, TERM is `tmux-256color`, so native detection doesn't activate. |
| Literal LF | `\n` (0x0a) | **Works.** Claude Code's input handler treats `\n` as "insert newline" and `\r` as "submit". This is what `/terminal-setup` configures terminals to send. |

The solution: send `\n` for Shift+Enter. This matches what Claude Code's `/terminal-setup` command configures (it makes terminals send `\n` for Shift+Enter), and what multiple users in [claude-code#1282](https://github.com/anthropics/claude-code/issues/1282) converged on as the working tmux workaround.

### Why the other keys don't have this problem

All other Shift+functional keys use standard xterm escape sequences that both tmux and applications recognize natively:

- Shift+Tab → `\x1b[Z` (standard back-tab / CBT, universally recognized)
- Shift+Home → `\x1b[1;2H`, Shift+End → `\x1b[1;2F` (xterm `;2` modifier)
- Shift+F1-F12 → `\x1b[N;2~` or `\x1b[1;2X` (xterm function key format)

These all use CSI final bytes (`Z`, `H`, `F`, `~`, `P`, `Q`, `R`, `S`) that tmux has parsed from terminfo for decades. Enter is unique because it has no standard modified escape sequence — it's just `\r` in every terminal.

## Our fix

### 1. Custom key handler in `TerminalView.tsx`

We use `attachCustomKeyEventHandler()` (ghostty-web's official API for intercepting keys) to catch all Shift-only functional keys BEFORE the buggy shortcut fires. The handler sends sequences directly to the WebSocket:

- Shift+Tab → `\x1b[Z` (standard back-tab)
- Shift+Enter → `\n` (LF — tells Claude Code "insert newline, don't submit")
- Shift+Home → `\x1b[1;2H`, Shift+End → `\x1b[1;2F`, etc. (xterm-style `;2` modifier)
- Shift+F1-F12 → xterm-style modified function key sequences

The handler returns `true` to stop ghostty-web from processing the event further. The sequence map and handler logic live in `src/mainview/shift-key-sequences.ts`.

### 2. No `extended-keys` in tmux config (intentional)

We considered `set -s extended-keys always` but removed it. All the xterm-style sequences we send (Shift+Home as `\x1b[1;2H`, Shift+F5 as `\x1b[15;2~`, etc.) exist in the `tmux-256color` terminfo. tmux forwards them correctly without extended-keys. Shift+Tab (`\x1b[Z`) is native terminfo. Shift+Enter (`\n`) isn't an escape sequence at all.

If a future inner application needs CSI u mode (Kitty keyboard protocol), add `set -s extended-keys always` to the tmux config. The `always` variant is preferred over `on` because `on` requires the outer terminal to respond to capability queries — and ghostty-web running through a Bun PTY may not respond correctly to tmux's `\x1b[?u` probe. You may also need `set -as terminal-features 'xterm-256color:extkeys'` for tmux to parse CSI u on INPUT from the outer terminal — see the "Notes for future maintainers" section below.

## Risks

- **`\n` for Shift+Enter is Claude Code-specific.** Other terminal applications might expect a proper escape sequence (modifyOtherKeys or CSI u) to distinguish Shift+Enter from a literal newline. If we need to support other apps in the future, see the notes below.
- **If ghostty-web fixes the bug upstream**, our handler is harmless — it fires first and sends the same sequences the fixed encoder would produce. No conflict.

## Notes for future maintainers

### If you need proper Shift+Enter escape sequences (not just `\n`)

The correct encodings for Shift+Enter are:
- **modifyOtherKeys**: `\x1b[27;2;13~` — what native Ghostty sends
- **CSI u (Kitty)**: `\x1b[13;2u` — what Kitty terminal sends

To make these work through tmux, you need BOTH of these tmux settings:
```
set -s extended-keys always
set -as terminal-features 'xterm-256color:extkeys'
```

The `terminal-features` line tells tmux that the outer terminal (TERM=xterm-256color, set in our PTY spawn at `pty-server.ts` line 312) supports extended keys. Without it, tmux's CSI parser doesn't recognize the `u` final byte (CSI u) and may not parse modifyOtherKeys parameter 27 either. The sequences get discarded or passed through as raw bytes.

Even with both settings, the inner application must also recognize the encoding. Claude Code 2.1.0+ recognizes modifyOtherKeys natively, but only when it detects a supporting terminal type — inside tmux (TERM=tmux-256color), this detection doesn't activate.

### Claude Code's `/terminal-setup`

Claude Code has a `/terminal-setup` slash command that configures the terminal emulator to send `\n` for Shift+Enter. It refuses to run inside tmux. It works on Apple Terminal, VSCode, Cursor, Windsurf, Zed, Alacritty. Ghostty, Kitty, iTerm2, WezTerm, and Warp support Shift+Enter natively without setup.

Since our app always runs Claude Code inside tmux, `/terminal-setup` is not an option. That's why we intercept at the ghostty-web layer and send `\n` directly.

### Alternative encoding: `\x1b\r` (ESC+CR)

Multiple users in claude-code#1282 confirmed that `\x1b\r` works through tmux for Shift+Enter. This is ambiguous (could be interpreted as Alt+Enter by some applications) but is widely compatible. Consider this if `\n` stops working in a future Claude Code version.

## Alternatives considered

- **Patching/forking ghostty-web**: Rejected. Maintaining a fork is expensive. The `attachCustomKeyEventHandler` API is the intended extension point.
- **CSI u (`\x1b[13;2u`) for Shift+Enter**: Doesn't work — tmux discards it without CSI u input parsing enabled.
- **modifyOtherKeys (`\x1b[27;2;13~`) for Shift+Enter**: Passes through tmux but Claude Code inside tmux doesn't recognize it (native terminal detection doesn't activate for TERM=tmux-256color).
- **`\x1b\r` (ESC+CR) for Shift+Enter**: Works, but ambiguous — could be Alt+Enter. `\n` is cleaner.
- **`extended-keys on` instead of `always`**: Requires the outer terminal to negotiate capabilities. Our outer terminal (ghostty-web → Bun PTY) may not respond to tmux's queries.
- **`terminal-features 'xterm-256color:extkeys'`**: Tried this to enable CSI u input parsing. Even with it, Claude Code still didn't recognize the escape sequences inside tmux. Removed to keep the config minimal, but documented above for future reference.

## Key files

- `src/mainview/shift-key-sequences.ts` — `SHIFT_KEY_SEQUENCES` map + `getShiftKeySequence()` helper
- `src/mainview/TerminalView.tsx` — `attachCustomKeyEventHandler` using the shared module
- `src/bun/pty-server.ts` — `TMUX_CONFIG` constant

## References

- [coder/ghostty-web#109](https://github.com/coder/ghostty-web/issues/109) — the upstream bug report (Shift+Tab + Alt+key on macOS)
- [anthropics/claude-code#1282](https://github.com/anthropics/claude-code/issues/1282) — Shift+Enter in Ghostty + tmux discussion (workarounds, what encodings work)
- [anthropics/claude-code#5757](https://github.com/anthropics/claude-code/issues/5757) — original Shift+Enter bug report for native Ghostty
