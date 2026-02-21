# Terminal Class

The main terminal emulator class. Provides an xterm.js-compatible API wrapping Ghostty's WASM terminal emulator.

## Import

```typescript
import { init, Terminal } from 'ghostty-web';
```

## Initialization

You must call `init()` before creating any Terminal instances:

```typescript
await init();
const term = new Terminal();
term.open(document.getElementById('terminal'));
```

For test isolation, pass a Ghostty instance directly:

```typescript
import { Ghostty, Terminal } from 'ghostty-web';
const ghostty = await Ghostty.load();
const term = new Terminal({ ghostty });
```

## Constructor

```typescript
new Terminal(options?: ITerminalOptions)
```

See [Interfaces](interfaces.md) for `ITerminalOptions` details.

Default options:
- `cols`: 80
- `rows`: 24
- `fontSize`: 15
- `fontFamily`: `'monospace'`
- `cursorBlink`: false
- `cursorStyle`: `'block'`
- `scrollback`: 10000
- `allowTransparency`: false
- `convertEol`: false
- `disableStdin`: false
- `smoothScrollDuration`: 100 (ms)

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `cols` | `number` | Current column count |
| `rows` | `number` | Current row count |
| `element` | `HTMLElement?` | Parent DOM element (set after `open()`) |
| `textarea` | `HTMLTextAreaElement?` | Hidden textarea for input |
| `buffer` | `IBufferNamespace` | Buffer API (normal/alternate screens) |
| `unicode` | `IUnicodeVersionProvider` | Unicode version info (15.1) |
| `options` | `Required<ITerminalOptions>` | Current options (mutable via Proxy) |
| `wasmTerm` | `GhosttyTerminal?` | Direct WASM terminal access |
| `renderer` | `CanvasRenderer?` | Direct renderer access |
| `viewportY` | `number` | Scroll position (0 = bottom) |

## Events

All events follow the xterm.js `IEvent<T>` pattern. Subscribe with `event(listener)`, returns `IDisposable`.

| Event | Type | Description |
|-------|------|-------------|
| `onData` | `IEvent<string>` | User input data (send to PTY) |
| `onResize` | `IEvent<{cols, rows}>` | Terminal resized |
| `onBell` | `IEvent<void>` | Bell character received |
| `onSelectionChange` | `IEvent<void>` | Selection changed |
| `onKey` | `IEvent<IKeyEvent>` | Key pressed |
| `onTitleChange` | `IEvent<string>` | Title changed (OSC 0/2) |
| `onScroll` | `IEvent<number>` | Viewport scrolled |
| `onRender` | `IEvent<{start, end}>` | Render completed |
| `onCursorMove` | `IEvent<void>` | Cursor position changed |

```typescript
// Subscribe
const disposable = term.onData((data) => {
  websocket.send(data);
});

// Unsubscribe
disposable.dispose();
```

## Lifecycle Methods

### `open(parent: HTMLElement): void`

Open terminal in a parent element. Initializes all components, creates canvas, starts render loop.

- Sets `tabindex` and `contenteditable` on parent for keyboard capture
- Creates hidden textarea for input
- Auto-focuses on open
- Throws if already open or disposed

### `dispose(): void`

Dispose terminal and clean up all resources. Stops render loop, disposes addons, removes DOM elements, frees WASM memory.

### `focus(): void`

Focus the terminal input.

### `blur(): void`

Remove focus from terminal.

## Write Methods

### `write(data: string | Uint8Array, callback?: () => void): void`

Write data to terminal. Handles VT100 escape sequence parsing via WASM. Auto-scrolls to bottom on new output. Processes terminal responses (DSR queries). Respects `convertEol` option.

### `writeln(data: string | Uint8Array, callback?: () => void): void`

Write data with `\r\n` appended.

### `paste(data: string): void`

Paste text into terminal. Uses bracketed paste mode (DEC mode 2004) if enabled by the running application. Respects `disableStdin`.

### `input(data: string, wasUserInput?: boolean): void`

Input data as if typed by user. If `wasUserInput` is true, triggers `onData` event. Otherwise writes directly to terminal.

## Display Methods

### `resize(cols: number, rows: number): void`

Resize terminal. Updates WASM terminal, renderer, canvas dimensions. Fires `onResize` event.

### `clear(): void`

Clear terminal screen (sends `\x1b[2J\x1b[H`).

### `reset(): void`

Reset terminal state completely. Frees old WASM terminal and creates a new one.

### `loadAddon(addon: ITerminalAddon): void`

Load an addon (e.g., FitAddon).

## Selection Methods

### `getSelection(): string`

Get selected text as string.

### `hasSelection(): boolean`

Check if there's an active selection.

### `clearSelection(): void`

Clear the current selection.

### `copySelection(): boolean`

Copy selection to clipboard. Returns true if text was copied.

### `selectAll(): void`

Select all text in terminal.

### `select(column: number, row: number, length: number): void`

Select text at specific position.

### `selectLines(start: number, end: number): void`

Select entire lines.

### `getSelectionPosition(): IBufferRange | undefined`

Get selection as buffer range.

## Scrolling Methods

### `scrollLines(amount: number): void`

Scroll by number of lines. Positive = down (toward current), negative = up (into history).

### `scrollPages(amount: number): void`

Scroll by number of pages.

### `scrollToTop(): void`

Scroll to top of scrollback buffer.

### `scrollToBottom(): void`

Scroll to bottom (current output).

### `scrollToLine(line: number): void`

Scroll to specific line in buffer.

### `getViewportY(): number`

Get current scroll position. 0 = at bottom, >0 = scrolled into history. May be fractional during smooth scroll animation.

## Event Handler Methods

### `attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void`

Attach custom keyboard handler. Return true to prevent default terminal handling.

### `attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void`

Attach custom wheel handler. Return true to prevent default scroll handling.

### `registerLinkProvider(provider: ILinkProvider): void`

Register a custom link detection provider. Terminal must be opened first. Built-in providers (OSC 8, URL regex) are registered automatically.

## Terminal Mode Methods

### `getMode(mode: number, isAnsi?: boolean): boolean`

Query terminal mode state. DEC modes (default) or ANSI modes.

### `hasBracketedPaste(): boolean`

Check if bracketed paste mode is enabled (DEC mode 2004).

### `hasFocusEvents(): boolean`

Check if focus event reporting is enabled (DEC mode 1004).

### `hasMouseTracking(): boolean`

Check if mouse tracking is enabled.

## Runtime Option Changes

Options can be changed at runtime after the terminal is opened:

```typescript
term.options.fontSize = 18;      // Triggers font change + re-render
term.options.fontFamily = 'Fira Code';
term.options.cursorStyle = 'bar';
term.options.cursorBlink = true;
term.options.disableStdin = true;
term.options.cols = 120;         // Triggers resize
term.options.rows = 40;
```

Options are wrapped in a Proxy that intercepts changes and applies them in real-time.
