# Public Exports

Complete public API surface of the `ghostty-web` package.

## Entry Point

```typescript
import { init, Terminal } from 'ghostty-web';
```

## Functions

| Export | Description |
|--------|-------------|
| `init()` | Initialize WASM module. Must be called before creating terminals. |
| `getGhostty()` | Get initialized Ghostty instance (internal). |

## Classes

| Export | Description |
|--------|-------------|
| `Terminal` | Main terminal class (xterm.js compatible) |
| `Ghostty` | WASM module loader |
| `GhosttyTerminal` | Low-level WASM terminal wrapper |
| `KeyEncoder` | Keyboard event -> escape sequence encoder |
| `CanvasRenderer` | Canvas-based terminal renderer |
| `InputHandler` | Keyboard/mouse event handler |
| `EventEmitter` | Event system (fire/subscribe/dispose) |
| `SelectionManager` | Text selection + clipboard |
| `FitAddon` | Auto-resize terminal to container |
| `LinkDetector` | Link detection coordinator |
| `OSC8LinkProvider` | OSC 8 hyperlink detection |
| `UrlRegexProvider` | URL regex detection |

## Enums

| Export | Description |
|--------|-------------|
| `CellFlags` | Cell style flags (BOLD, ITALIC, etc.) |
| `KeyEncoderOption` | Key encoder configuration options |
| `Key` | Physical key codes |
| `KeyAction` | Key actions (PRESS, RELEASE, REPEAT) |
| `Mods` | Modifier key flags (SHIFT, CTRL, etc.) |
| `DirtyState` | Render state dirty flags |
| `KittyKeyFlags` | Kitty keyboard protocol flags |
| `SgrAttributeTag` | SGR attribute tags |
| `TerminalMode` | Terminal mode identifiers |

## Types (TypeScript only)

| Export | Description |
|--------|-------------|
| `ITerminalOptions` | Terminal constructor options |
| `ITheme` | Color theme |
| `ITerminalAddon` | Addon interface |
| `ITerminalCore` | Minimal terminal interface for addons |
| `IDisposable` | Disposable pattern |
| `IEvent` | Event subscription function type |
| `IBufferRange` | Buffer coordinate range |
| `IKeyEvent` | Key event with DOM event |
| `IUnicodeVersionProvider` | Unicode version info |
| `KeyEvent` | WASM key event structure |
| `GhosttyCell` | WASM cell structure |
| `RGB` | RGB color |
| `Cursor` | Cursor position |
| `TerminalHandle` | Opaque WASM terminal pointer |
| `RendererOptions` | Renderer constructor options |
| `FontMetrics` | Font measurement data |
| `IRenderable` | Renderable interface for renderer |
| `ITerminalDimensions` | Cols/rows dimensions |
| `SelectionCoordinates` | Selection position data |
| `ILink` | Link interface |
| `ILinkProvider` | Link provider interface |
| `IBufferCellPosition` | Buffer cell coordinate |

## Import Patterns

### Basic Usage

```typescript
import { init, Terminal } from 'ghostty-web';

await init();
const term = new Terminal({ fontSize: 14 });
term.open(container);
```

### With FitAddon

```typescript
import { init, Terminal, FitAddon } from 'ghostty-web';

await init();
const term = new Terminal();
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(container);
fitAddon.fit();
fitAddon.observeResize();
```

### Advanced (Direct WASM Access)

```typescript
import { Ghostty, GhosttyTerminal, CellFlags, Key, Mods, KeyAction } from 'ghostty-web';

const ghostty = await Ghostty.load();
const wasmTerm = ghostty.createTerminal(80, 24);
wasmTerm.write('Hello\x1b[1;32m World\x1b[0m\r\n');

const cells = wasmTerm.getLine(0);
const isBold = (cells[0].flags & CellFlags.BOLD) !== 0;
```

### Custom Link Provider

```typescript
import { init, Terminal } from 'ghostty-web';
import type { ILinkProvider, ILink } from 'ghostty-web';

await init();
const term = new Terminal();
term.open(container);

term.registerLinkProvider({
  provideLinks(y, callback) {
    // Custom link detection logic
    callback(links);
  },
});
```

## Package Info

```json
{
  "name": "ghostty-web",
  "version": "0.3.0",
  "type": "module",
  "main": "./dist/ghostty-web.umd.cjs",
  "module": "./dist/ghostty-web.js",
  "types": "./dist/index.d.ts"
}
```

Exports both ESM and UMD formats. The WASM file (`ghostty-vt.wasm`) is included in the package.
