# Architecture

## System Overview

```
+---------------------------------------------+
|  Terminal (lib/terminal.ts)                  |  xterm.js-compatible API
|  - Public API, event handling                |
+-------+-------------------------------------+
        |
        +---> GhosttyTerminal (WASM)
        |     - VT100 state machine, screen buffer
        |
        +---> CanvasRenderer (lib/renderer.ts)
        |     - 60 FPS rendering, all colors/styles
        |
        +---> InputHandler (lib/input-handler.ts)
        |     - Keyboard events -> escape sequences
        |
        +---> SelectionManager (lib/selection-manager.ts)
              - Text selection + clipboard

Ghostty WASM Bridge (lib/ghostty.ts)
+- Ghostty          - WASM loader
+- GhosttyTerminal  - Terminal instance wrapper
+- KeyEncoder       - Keyboard event encoding
```

## Key Files

| File | Purpose |
|------|---------|
| `lib/index.ts` | Public API entry point, `init()` function |
| `lib/terminal.ts` | Main Terminal class, xterm.js API |
| `lib/ghostty.ts` | WASM bridge, memory management |
| `lib/renderer.ts` | Canvas renderer with font metrics |
| `lib/input-handler.ts` | Keyboard -> escape sequences |
| `lib/selection-manager.ts` | Text selection + clipboard |
| `lib/types.ts` | TypeScript definitions for WASM ABI |
| `lib/interfaces.ts` | xterm.js-compatible interfaces |
| `lib/event-emitter.ts` | Event system (IDisposable pattern) |
| `lib/link-detector.ts` | Link detection and caching |
| `lib/addons/fit.ts` | Responsive terminal sizing (FitAddon) |
| `lib/providers/osc8-link-provider.ts` | OSC 8 hyperlink detection |
| `lib/providers/url-regex-provider.ts` | URL regex detection |
| `lib/buffer.ts` | Buffer API (normal/alternate screens) |

## WASM Integration

### What's in Ghostty WASM

- VT100/ANSI state machine (the hard part)
- Screen buffer (2D cell grid)
- Cursor tracking
- Scrollback buffer
- SGR parsing (colors/styles)
- Key encoding (Kitty keyboard protocol)
- Terminal mode tracking

### What's in TypeScript

- Terminal API (xterm.js compatibility)
- Canvas rendering
- Input event handling (DOM -> escape sequences)
- Selection/clipboard
- Addons (FitAddon)
- WebSocket/PTY integration
- Link detection

### Memory Management

- WASM exports linear memory
- TypeScript reads cell data via typed arrays (`Uint8Array`, `DataView`)
- No manual malloc/free needed (Ghostty manages internally)
- Cell data is read from a reusable viewport buffer (zero-allocation after warmup)
- Get all cells: `wasmTerm.getViewport()` (ONE WASM call for entire screen)
- WASM memory buffer may be invalidated on growth -- always get fresh buffer reference

```typescript
// WRONG - buffer may become invalid
const buffer = this.memory.buffer;
// ... time passes, memory grows ...
const view = new Uint8Array(buffer); // May be detached!

// CORRECT - get fresh buffer each time
const view = new Uint8Array(this.memory.buffer, ptr, size);
```

### RenderState API

The key performance optimization. Instead of per-row WASM boundary crossings:

1. `update()` -- syncs RenderState with terminal state (one WASM call)
2. `getViewport()` -- gets ALL cells in one WASM call
3. `isRowDirty(y)` -- checks if row needs redrawing
4. `markClean()` -- resets dirty flags after rendering

This means ONE WASM boundary crossing to get all render data, instead of one per row.

## Cell Structure

Each cell is 16 bytes in WASM memory:

```
| Offset | Size | Field         | Description |
|--------|------|---------------|-------------|
| 0      | 4    | codepoint     | Unicode codepoint (u32) |
| 4      | 1    | fg_r          | Foreground red (u8) |
| 5      | 1    | fg_g          | Foreground green (u8) |
| 6      | 1    | fg_b          | Foreground blue (u8) |
| 7      | 1    | bg_r          | Background red (u8) |
| 8      | 1    | bg_g          | Background green (u8) |
| 9      | 1    | bg_b          | Background blue (u8) |
| 10     | 1    | flags         | Style flags bitfield (u8) |
| 11     | 1    | width         | Character width 1=normal, 2=wide (u8) |
| 12     | 2    | hyperlink_id  | 0=no link, >0=hyperlink ID (u16) |
| 14     | 1    | grapheme_len  | Extra codepoints beyond first (u8) |
| 15     | 1    | (padding)     | |
```

## Event Flow

### User Input -> PTY

```
Keyboard Event (DOM)
  -> InputHandler (maps key to escape sequence via WASM KeyEncoder)
    -> Terminal.onData event
      -> Application sends to WebSocket/PTY
```

### PTY Output -> Screen

```
WebSocket/PTY data
  -> Terminal.write(data)
    -> GhosttyTerminal.write() (WASM VT100 parsing)
      -> RenderState updated (dirty flags set)
        -> CanvasRenderer.render() (60 FPS loop)
          -> Canvas draws only dirty rows
```

## Rendering Pipeline

1. **Render loop** runs at 60 FPS via `requestAnimationFrame`
2. Calls `wasmTerm.update()` to sync render state
3. Checks `isRowDirty(y)` for each row
4. Only redraws dirty rows (partial redraw optimization)
5. Draws cells with correct colors, styles (bold, italic, underline, etc.)
6. Draws cursor (block, underline, or bar)
7. Draws selection overlay
8. Draws scrollbar (with auto-hide fade animation)
9. Calls `markClean()` to reset dirty flags
