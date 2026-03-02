## Context

Cyrillic (and all non-ASCII) characters rendered as underscores in the production terminal, but worked fine in dev mode. Multiple hypotheses were tested: font loading, canvas rendering, WASM VT parser, WebKit custom scheme bugs.

## Investigation

- Font files confirmed to contain 122 Cyrillic glyphs (fonttools analysis)
- Canvas `measureText("Б")` returned correct width — font available to canvas
- `fillText` interceptor showed ghostty-web was rendering literal underscore (0x5F), not replacement chars
- WebSocket diagnostic showed **zero Cyrillic codepoints in incoming data** — the data from the PTY server already contained underscores instead of Cyrillic
- Same tmux session showed Cyrillic correctly when attached from iTerm2 terminal

## Decision

Root cause: macOS `.app` bundles inherit a minimal environment without `LANG`. When tmux is spawned without `LANG` (or `LC_ALL`), it assumes the client does not support UTF-8 and replaces all non-ASCII characters with underscores in its **output stream** (box drawing uses DEC Special escape sequences, bypassing this check).

Fix in three files:
- `src/bun/shell-env.ts`: `resolveShellEnv()` now resolves both PATH and LANG from the user's login shell
- `src/bun/index.ts`: patches `process.env.LANG` at startup alongside PATH, with `en_US.UTF-8` fallback
- `src/bun/pty-server.ts`: explicitly passes `LANG` in the PTY spawn environment

## Risks

- If user's shell has an exotic LANG (e.g., `ja_JP.UTF-8`), it will be used as-is — should be fine since UTF-8 is what matters
- The `en_US.UTF-8` fallback assumes the locale exists on the system — it does on all modern macOS

## Alternatives considered

- Passing `-u` flag to tmux — this is deprecated in tmux 3.x
- Setting `LANG` only in pty-server without resolving from shell — would work but misses other locale-dependent behavior
- Base64 font embedding — was attempted, didn't help because the issue was in tmux, not canvas
