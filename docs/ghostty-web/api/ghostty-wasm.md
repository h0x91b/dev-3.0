# Ghostty WASM API

Low-level WASM bridge classes for direct access to Ghostty's terminal emulator.

## Ghostty

Main WASM loader class.

### Static Methods

#### `Ghostty.load(wasmPath?: string): Promise<Ghostty>`

Load the Ghostty WASM module. Tries multiple paths:

1. Explicit `wasmPath` if provided
2. Relative to the module (`../ghostty-vt.wasm`)
3. `./ghostty-vt.wasm`
4. `/ghostty-vt.wasm`

Works in Bun (via `Bun.file`), Node.js (via `fs/promises`), and browsers (via `fetch`).

### Instance Methods

#### `createTerminal(cols?: number, rows?: number, config?: GhosttyTerminalConfig): GhosttyTerminal`

Create a new terminal instance.

#### `createKeyEncoder(): KeyEncoder`

Create a new key encoder for converting keyboard events to escape sequences.

## GhosttyTerminal

High-performance terminal emulator wrapper. Uses Ghostty's native RenderState for optimal performance.

### Constructor Config

```typescript
interface GhosttyTerminalConfig {
  scrollbackLimit?: number;  // Default: 10000
  fgColor?: number;          // 0xRRGGBB format, 0 = default
  bgColor?: number;          // 0xRRGGBB format, 0 = default
  cursorColor?: number;      // 0xRRGGBB format, 0 = default
  palette?: number[];        // 16 ANSI colors in 0xRRGGBB format
}
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `cols` | `number` | Current column count |
| `rows` | `number` | Current row count |

### Lifecycle Methods

#### `write(data: string | Uint8Array): void`

Write data to terminal. WASM handles VT100 escape sequence parsing.

#### `resize(cols: number, rows: number): void`

Resize terminal dimensions. Invalidates internal buffers.

#### `free(): void`

Free WASM resources. Must be called when done.

### RenderState API

The key performance optimization -- ONE WASM call gets ALL render data.

#### `update(): DirtyState`

Sync render state with terminal. Returns dirty state:
- `DirtyState.NONE` (0) -- no changes
- `DirtyState.PARTIAL` (1) -- some rows changed
- `DirtyState.FULL` (2) -- full redraw needed (screen switch, resize)

Safe to call multiple times. Dirty state persists until `markClean()`.

#### `getViewport(): GhosttyCell[]`

Get ALL viewport cells in ONE WASM call. Returns reusable cell array (zero allocation after warmup). Cell pool is shared -- do not hold references across calls.

#### `getCursor(): RenderStateCursor`

Get cursor state. Calls `update()` internally.

```typescript
interface RenderStateCursor {
  x: number;
  y: number;
  viewportX: number;
  viewportY: number;
  visible: boolean;
  blinking: boolean;
  style: 'block' | 'underline' | 'bar';
}
```

#### `getColors(): RenderStateColors`

Get default terminal colors.

```typescript
interface RenderStateColors {
  background: RGB;
  foreground: RGB;
  cursor: RGB | null;
}
```

#### `isRowDirty(y: number): boolean`

Check if a specific row needs redrawing.

#### `markClean(): void`

Reset dirty flags. Call after rendering.

### Compatibility Methods

#### `getLine(y: number): GhosttyCell[] | null`

Get cells for a single row. Returns deep copies. Calls `update()` internally.

#### `isDirty(): boolean`

Check if any changes need rendering.

#### `needsFullRedraw(): boolean`

Check if full redraw is needed.

#### `clearDirty(): void`

Alias for `markClean()`.

#### `getDimensions(): { cols: number; rows: number }`

Get terminal dimensions.

### Scrollback API

#### `getScrollbackLength(): number`

Get number of scrollback lines (history only, not active screen).

#### `getScrollbackLine(offset: number): GhosttyCell[] | null`

Get a line from scrollback. `offset` 0 = oldest line, `(length-1)` = most recent.

### Grapheme API

For complex scripts (Hindi, emoji with ZWJ, etc.) that use multiple codepoints per visual character.

#### `getGrapheme(row: number, col: number): number[] | null`

Get all codepoints for a grapheme cluster at position. Returns array of Unicode codepoints.

#### `getGraphemeString(row: number, col: number): string`

Get string representation of grapheme at position.

#### `getScrollbackGrapheme(offset: number, col: number): number[] | null`

Get grapheme from scrollback buffer.

#### `getScrollbackGraphemeString(offset: number, col: number): string`

Get string representation of scrollback grapheme.

### Terminal Modes

#### `isAlternateScreen(): boolean`

Check if in alternate screen mode (vim, less, htop).

#### `hasBracketedPaste(): boolean`

Check DEC mode 2004.

#### `hasFocusEvents(): boolean`

Check DEC mode 1004.

#### `hasMouseTracking(): boolean`

Check if any mouse tracking mode is active.

#### `getMode(mode: number, isAnsi?: boolean): boolean`

Query arbitrary terminal mode. Default is DEC mode (`isAnsi = false`).

#### `isRowWrapped(row: number): boolean`

Check if row is soft-wrapped to next line.

### Response API

#### `hasResponse(): boolean`

Check if terminal has pending responses (from DSR queries).

#### `readResponse(): string | null`

Read next pending response. Returns null if no responses. Responses are generated by escape sequences like DSR 6 (cursor position query).

## KeyEncoder

Converts keyboard events into terminal escape sequences using Ghostty's WASM encoder.

### Methods

#### `setOption(option: KeyEncoderOption, value: boolean | number): void`

Set encoder option.

```typescript
enum KeyEncoderOption {
  CURSOR_KEY_APPLICATION = 0,   // DEC mode 1
  KEYPAD_KEY_APPLICATION = 1,   // DEC mode 66
  IGNORE_KEYPAD_WITH_NUMLOCK = 2,
  ALT_ESC_PREFIX = 3,           // DEC mode 1036
  MODIFY_OTHER_KEYS_STATE_2 = 4,
  KITTY_KEYBOARD_FLAGS = 5,
}
```

#### `setKittyFlags(flags: KittyKeyFlags): void`

Set Kitty keyboard protocol flags.

#### `encode(event: KeyEvent): Uint8Array`

Encode a key event to terminal escape sequence bytes.

```typescript
interface KeyEvent {
  action: KeyAction;     // RELEASE, PRESS, REPEAT
  key: Key;              // Physical key code
  mods: Mods;            // Modifier keys
  consumedMods?: Mods;
  composing?: boolean;
  utf8?: string;         // UTF-8 text for the key
  unshiftedCodepoint?: number;
}
```

#### `dispose(): void`

Free WASM resources.
