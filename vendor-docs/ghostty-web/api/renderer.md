# Canvas Renderer

High-performance canvas-based renderer for the terminal display.

## Features

- Font metrics measurement with DPI scaling
- Full color support (256-color palette + RGB)
- All text styles (bold, italic, underline, strikethrough, blink, inverse, invisible, faint)
- Multiple cursor styles (block, underline, bar)
- Cursor blink animation
- Dirty line optimization for 60 FPS
- Selection overlay rendering
- Link underline rendering (OSC 8 and regex)
- Scrollbar with auto-hide and fade animation
- Scrollback content rendering

## CanvasRenderer

### Constructor

```typescript
new CanvasRenderer(canvas: HTMLCanvasElement, options?: RendererOptions)
```

```typescript
interface RendererOptions {
  fontSize?: number;         // Default: 15
  fontFamily?: string;       // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;     // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
}
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `charWidth` | `number` | Character cell width in CSS pixels |
| `charHeight` | `number` | Character cell height in CSS pixels |

### Methods

#### `render(term: IRenderable, forceAll: boolean, viewportY: number, scrollProvider: IScrollbackProvider, scrollbarOpacity?: number): void`

Main render method called by the terminal's 60 FPS loop.

- `forceAll`: Force full redraw (ignoring dirty flags)
- `viewportY`: Scroll position (0 = bottom, >0 = scrolled up)
- `scrollbarOpacity`: 0-1 for scrollbar fade animation

#### `resize(cols: number, rows: number): void`

Resize canvas to fit terminal dimensions. Handles DPI scaling.

#### `clear(): void`

Clear the entire canvas.

#### `getMetrics(): FontMetrics`

Get current font metrics.

```typescript
interface FontMetrics {
  width: number;     // Character cell width in CSS pixels
  height: number;    // Character cell height in CSS pixels
  baseline: number;  // Distance from top to text baseline
}
```

#### `setCursorStyle(style: 'block' | 'underline' | 'bar'): void`

Change cursor style at runtime.

#### `setCursorBlink(blink: boolean): void`

Enable/disable cursor blink.

#### `setFontSize(size: number): void`

Change font size at runtime.

#### `setFontFamily(family: string): void`

Change font family at runtime.

#### `setSelectionManager(manager: SelectionManager): void`

Connect selection manager for rendering selection overlay.

#### `setHoveredHyperlinkId(id: number): void`

Set the hyperlink ID to underline (0 = none). Used for OSC 8 hover.

#### `setHoveredLinkRange(range: {startX, startY, endX, endY} | null): void`

Set range to underline for regex URL hover.

#### `dispose(): void`

Clean up resources.

## IRenderable Interface

Objects that can be rendered must implement:

```typescript
interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  getCursor(): { x: number; y: number; visible: boolean };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  getGraphemeString?(row: number, col: number): string;
}
```

## IScrollbackProvider Interface

```typescript
interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}
```

## Rendering Details

### Dirty Row Optimization

The renderer only redraws rows that have changed:

1. Calls `update()` on WASM terminal to sync render state
2. Checks `isRowDirty(y)` for each row
3. Only redraws dirty rows
4. Calls `markClean()` after rendering

Full redraws happen on: screen switch (normal <-> alternate), resize, or forced.

### DPI Scaling

Canvas is scaled for high-DPI displays:

```
canvas.width = cssWidth * devicePixelRatio
canvas.height = cssHeight * devicePixelRatio
ctx.scale(devicePixelRatio, devicePixelRatio)
```

### Scrollback Rendering

When `viewportY > 0`, the renderer composites scrollback and screen content:

- Top rows: from scrollback buffer (oldest lines)
- Bottom rows: from active screen buffer
- Transition point: `viewportY` determines how many scrollback rows are visible
