# FitAddon

Auto-resize terminal to fit its container element. Compatible with xterm.js FitAddon API.

## Import

```typescript
import { FitAddon } from 'ghostty-web';
```

## Usage

```typescript
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

// After opening terminal
term.open(container);

// Manual fit
fitAddon.fit();

// Auto-fit on container resize
fitAddon.observeResize();

// On window resize (alternative to observeResize)
window.addEventListener('resize', () => fitAddon.fit());
```

## Methods

### `fit(): void`

Fit the terminal to its container. Calculates optimal dimensions based on:

- Container element dimensions (`clientWidth` / `clientHeight`)
- Container padding
- Font metrics (character cell size from renderer)
- Reserved scrollbar width (15px)

Does nothing if:
- Dimensions cannot be calculated
- Dimensions haven't changed (prevents feedback loops)
- Currently resizing (prevents re-entrant calls)

### `proposeDimensions(): ITerminalDimensions | undefined`

Calculate optimal dimensions without applying them.

```typescript
interface ITerminalDimensions {
  cols: number;
  rows: number;
}
```

Returns `undefined` if calculation is not possible (no DOM element, no renderer, zero-size container).

### `observeResize(): void`

Set up a `ResizeObserver` to automatically call `fit()` when the container size changes. Resize events are debounced by 100ms to avoid excessive calls during window drag.

### `dispose(): void`

Stop observing and clean up resources.

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MINIMUM_COLS` | 2 | Minimum column count |
| `MINIMUM_ROWS` | 1 | Minimum row count |
| `DEFAULT_SCROLLBAR_WIDTH` | 15 | Reserved space for scrollbar (px) |
| `RESIZE_DEBOUNCE_MS` | 100 | Debounce time for ResizeObserver (ms) |

## Important Notes

- The terminal must be opened (`term.open()`) before `fit()` can calculate dimensions
- `fit()` reads from the container's `clientWidth`/`clientHeight`, not the canvas size
- Padding is automatically subtracted from available space
- The addon observes the container element, not the canvas -- so external resizes trigger properly
