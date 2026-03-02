# ghostty-web

[Ghostty](https://github.com/ghostty-org/ghostty) for the web with [xterm.js](https://github.com/xtermjs/xterm.js) API compatibility -- a proper VT100 implementation in the browser.

- Migrate from xterm by changing your import: `@xterm/xterm` -> `ghostty-web`
- WASM-compiled parser from Ghostty -- the same code that runs the native app
- Zero runtime dependencies, ~400KB WASM bundle

Originally created for [Mux](https://github.com/coder/mux) (a desktop app for isolated, parallel agentic development), but designed to be used anywhere.

## Comparison with xterm.js

xterm.js reimplements terminal emulation in JavaScript. Ghostty's emulator is the same battle-tested code that runs the native Ghostty app.

| Issue | xterm.js | ghostty-web |
|-------|----------|-------------|
| **Complex scripts** (Devanagari, Arabic) | Rendering issues | Proper grapheme handling |
| **XTPUSHSGR/XTPOPSGR** | Not supported | Full support |

## Installation

```bash
npm install ghostty-web
```

## Quick Start

```javascript
import { init, Terminal } from 'ghostty-web';

await init();

const term = new Terminal({
  fontSize: 14,
  theme: {
    background: '#1a1b26',
    foreground: '#a9b1d6',
  },
});

term.open(document.getElementById('terminal'));
term.onData((data) => websocket.send(data));
websocket.onmessage = (e) => term.write(e.data);
```

## What Works

- Full VT100/ANSI terminal emulation (vim, htop, colors, etc.)
- Canvas-based renderer with 60 FPS
- Keyboard input handling (Kitty keyboard protocol)
- Text selection and clipboard
- WebSocket PTY integration (real shell sessions)
- xterm.js-compatible API
- FitAddon for responsive sizing
- Link detection (OSC 8 hyperlinks + URL regex)
- Scrollback buffer with smooth scrolling
- Scrollbar with auto-hide

## Tech Stack

- TypeScript + Bun runtime
- Vite for dev server and bundling
- Ghostty WASM (404 KB) for VT100 parsing
- Canvas API for rendering

## Documentation

### Guides

- [Architecture](guides/architecture.md) -- system overview, key files, WASM integration
- [Development](guides/development.md) -- setup, testing, debugging, workflows

### API Reference

- [Terminal](api/terminal.md) -- main Terminal class (xterm.js compatible)
- [Interfaces](api/interfaces.md) -- ITerminalOptions, ITheme, IBufferNamespace, etc.
- [Ghostty WASM](api/ghostty-wasm.md) -- Ghostty, GhosttyTerminal, KeyEncoder
- [Renderer](api/renderer.md) -- CanvasRenderer, font metrics, themes
- [FitAddon](api/fit-addon.md) -- auto-resize terminal to container
- [Input Handler](api/input-handler.md) -- keyboard events, mouse tracking
- [Selection](api/selection-manager.md) -- text selection, clipboard
- [Link Detection](api/link-detection.md) -- OSC 8 hyperlinks, URL regex
- [Types & Enums](api/types.md) -- GhosttyCell, CellFlags, Key, Mods, etc.
- [Exports](api/exports.md) -- complete public API surface

## License

[MIT](https://github.com/coder/ghostty-web/blob/main/LICENSE)
