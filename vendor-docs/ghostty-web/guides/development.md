# Development Guide

## Setup

```bash
bun install       # Install dependencies
bun test          # Run test suite
bun run dev       # Start Vite dev server (http://localhost:8000)
```

## Pre-commit Checks

Always run before committing:

```bash
bun run fmt && bun run lint && bun run typecheck && bun test && bun run build
```

Individual checks:

```bash
bun run fmt          # Check formatting (Prettier)
bun run fmt:fix      # Auto-fix formatting
bun run lint         # Run linter (Biome)
bun run lint:fix     # Auto-fix lint issues
bun run typecheck    # Type check (TypeScript)
bun test             # Run tests
bun run build        # Build library
```

## Running Tests

```bash
bun test                          # Run all tests
bun test lib/terminal.test.ts     # Run specific file
bun test --watch                  # Watch mode (may hang - Ctrl+C to restart)
bun test -t "test name pattern"   # Run matching tests
```

Test files are located at `lib/*.test.ts`:
- `terminal.test.ts`
- `renderer.test.ts`
- `input-handler.test.ts`
- `selection-manager.test.ts`
- `buffer.test.ts`
- `scrolling.test.ts`
- `url-detection.test.ts`
- `lib/addons/fit.test.ts`

### Test Patterns

```typescript
import { describe, test, expect } from 'bun:test';

describe('MyFeature', () => {
  test('should do something', async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    const container = document.createElement('div');
    await term.open(container);

    term.write('test\r\n');

    // Check WASM state
    const cursor = term.wasmTerm!.getCursor();
    expect(cursor.y).toBe(1);

    term.dispose();
  });
});
```

- Use `document.createElement()` for DOM elements
- Always `await term.open()` before testing
- Always `term.dispose()` in cleanup
- Use `term.wasmTerm` to access WASM API directly

## Running Demos

Use Vite dev server (not plain HTTP server -- browser can't load `.ts` files directly):

```bash
bun run dev          # Vite with TS support (http://localhost:8000)
```

Available demos:
- `demo/index.html` -- Interactive shell terminal (requires PTY server)
- `demo/colors-demo.html` -- ANSI color showcase (no server needed)
- `demo/scrollbar-test.html` -- Scrollbar behavior test

### Interactive Shell Demo

```bash
# Terminal 1: Start PTY server
cd demo/server && bun install && bun run start

# Terminal 2: Start web server
bun run dev

# Open: http://localhost:8000/demo/
```

WebSocket connects to `ws://localhost:3001/ws` (or current hostname).

### Demo Server (`@ghostty-web/demo`)

Cross-platform demo server:

```bash
npx @ghostty-web/demo@next          # Default port 8080
PORT=3000 npx @ghostty-web/demo@next  # Custom port
```

Features:
- Starts HTTP + WebSocket PTY server on same port
- Opens real shell session (bash, zsh, etc.)
- Full PTY support (colors, cursor, resize)
- Supports reverse proxies (ngrok, nginx)

## Building

```bash
bun run build         # Full build (WASM + library)
bun run build:lib     # Build library only (Vite)
bun run build:wasm    # Rebuild WASM from Ghostty source
bun run clean         # Remove dist/
```

The WASM binary (`ghostty-vt.wasm`, 404 KB) is committed to the repo. You don't need to rebuild unless updating the Ghostty version.

Rebuilding WASM requires Zig and Bun.

## Debugging

### Browser Console

```javascript
// Access terminal instance
term.write('Hello!\r\n');
console.log(term.cols, term.rows);
term.wasmTerm.getCursor();  // WASM cursor state

// Check WASM memory
const cells = term.wasmTerm.getLine(0);
console.log(cells);
```

### Common Issues

| Issue | Where to look |
|-------|--------------|
| Rendering glitches | `renderer.ts` dirty tracking |
| Input not working | `input-handler.ts` key mappings |
| Selection broken | `selection-manager.ts` mouse handlers |
| WASM crashes | Memory buffer validity (may change on memory growth) |

## Code Patterns

### Adding Terminal Features

```typescript
export class Terminal {
  // Add public method
  public myFeature(): void {
    if (!this.wasmTerm) throw new Error('Not open');
    this.wasmTerm.write('...');
  }

  // Add event
  private myEventEmitter = new EventEmitter<string>();
  public readonly onMyEvent = this.myEventEmitter.event;
}
```

### Creating Addons

```typescript
export class MyAddon implements ITerminalAddon {
  private terminal?: Terminal;

  activate(terminal: Terminal): void {
    this.terminal = terminal;
  }

  dispose(): void {
    // Cleanup
  }
}
```

### Using Ghostty WASM API Directly

```typescript
const ghostty = await Ghostty.load('./ghostty-vt.wasm');
const wasmTerm = ghostty.createTerminal(80, 24);

// Write data (processes VT100 sequences)
wasmTerm.write('Hello\r\n\x1b[1;32mGreen\x1b[0m');

// Read screen state
const cursor = wasmTerm.getCursor();  // {x, y, visible, ...}
const cells = wasmTerm.getLine(0);    // GhosttyCell[]
const cell = cells[0];                // {codepoint, fg, bg, flags}

// Check cell flags
const isBold = (cell.flags & CellFlags.BOLD) !== 0;

// Resize
wasmTerm.resize(100, 30);

// Clear screen
wasmTerm.write('\x1bc');  // RIS (Reset to Initial State)
```

### Event System

```typescript
// Terminal uses EventEmitter for xterm.js compatibility
private dataEmitter = new EventEmitter<string>();
public readonly onData = this.dataEmitter.event;

// Emit events
this.dataEmitter.fire('user input data');

// Subscribe (returns IDisposable)
const disposable = term.onData(data => {
  console.log(data);
});
disposable.dispose();  // Unsubscribe
```

## Critical Gotchas

1. **Must use Vite dev server** -- browser can't load `.ts` files directly
2. **WASM binary is committed** -- don't rebuild unless updating Ghostty version
3. **`bun test` may hang on completion** -- use `Ctrl+C` to exit (tests pass before hang)
4. **WASM memory buffer invalidation** -- always get fresh `memory.buffer` reference
5. **PTY server required for interactive demos** -- `cd demo/server && bun run start`
6. **Canvas rendering requires FitAddon** -- call `fitAddon.fit()` after opening terminal
