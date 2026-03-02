# Types & Enums

TypeScript type definitions for the Ghostty WASM API.

## Cell Types

### GhosttyCell

Cell structure matching `ghostty_cell_t` in WASM (16 bytes).

```typescript
interface GhosttyCell {
  codepoint: number;      // u32 - Unicode codepoint (first of grapheme)
  fg_r: number;           // u8 - foreground red
  fg_g: number;           // u8 - foreground green
  fg_b: number;           // u8 - foreground blue
  bg_r: number;           // u8 - background red
  bg_g: number;           // u8 - background green
  bg_b: number;           // u8 - background blue
  flags: number;          // u8 - style flags bitfield (CellFlags)
  width: number;          // u8 - character width (1=normal, 2=wide)
  hyperlink_id: number;   // u16 - 0=no link, >0=hyperlink ID
  grapheme_len: number;   // u8 - extra codepoints beyond first
}
```

### CellFlags

Style flags bitfield for `GhosttyCell.flags`.

```typescript
enum CellFlags {
  BOLD          = 1 << 0,  // 0x01
  ITALIC        = 1 << 1,  // 0x02
  UNDERLINE     = 1 << 2,  // 0x04
  STRIKETHROUGH = 1 << 3,  // 0x08
  INVERSE       = 1 << 4,  // 0x10
  INVISIBLE     = 1 << 5,  // 0x20
  BLINK         = 1 << 6,  // 0x40
  FAINT         = 1 << 7,  // 0x80
}
```

Usage:

```typescript
const isBold = (cell.flags & CellFlags.BOLD) !== 0;
const isItalic = (cell.flags & CellFlags.ITALIC) !== 0;
```

### RGB

```typescript
interface RGB {
  r: number;
  g: number;
  b: number;
}
```

### Cursor

```typescript
interface Cursor {
  x: number;
  y: number;
  visible: boolean;
}
```

## Render State Types

### DirtyState

```typescript
enum DirtyState {
  NONE    = 0,  // No changes
  PARTIAL = 1,  // Some rows changed
  FULL    = 2,  // Full redraw needed
}
```

### RenderStateCursor

```typescript
interface RenderStateCursor {
  x: number;
  y: number;
  viewportX: number;    // -1 if not in viewport
  viewportY: number;
  visible: boolean;
  blinking: boolean;
  style: 'block' | 'underline' | 'bar';
}
```

### RenderStateColors

```typescript
interface RenderStateColors {
  background: RGB;
  foreground: RGB;
  cursor: RGB | null;
}
```

## Key Types

### Key

Physical key codes matching Ghostty's internal `Key` enum. Used by the KeyEncoder.

```typescript
enum Key {
  UNIDENTIFIED = 0,

  // Writing System Keys
  GRAVE = 1,           // ` and ~
  BACKSLASH = 2,       // \ and |
  BRACKET_LEFT = 3,    // [ and {
  BRACKET_RIGHT = 4,   // ] and }
  COMMA = 5,           // , and <
  ZERO = 6, ONE = 7, TWO = 8, THREE = 9, FOUR = 10,
  FIVE = 11, SIX = 12, SEVEN = 13, EIGHT = 14, NINE = 15,
  EQUAL = 16,          // = and +
  A = 20, B = 21, C = 22, D = 23, E = 24, F = 25,
  G = 26, H = 27, I = 28, J = 29, K = 30, L = 31,
  M = 32, N = 33, O = 34, P = 35, Q = 36, R = 37,
  S = 38, T = 39, U = 40, V = 41, W = 42, X = 43,
  Y = 44, Z = 45,
  MINUS = 46, PERIOD = 47, QUOTE = 48,
  SEMICOLON = 49, SLASH = 50,

  // Functional Keys
  ALT_LEFT = 51, ALT_RIGHT = 52,
  BACKSPACE = 53, CAPS_LOCK = 54,
  CONTROL_LEFT = 56, CONTROL_RIGHT = 57,
  ENTER = 58,
  META_LEFT = 59, META_RIGHT = 60,
  SHIFT_LEFT = 61, SHIFT_RIGHT = 62,
  SPACE = 63, TAB = 64,

  // Control Pad
  DELETE = 68, END = 69, HOME = 71,
  INSERT = 72, PAGE_DOWN = 73, PAGE_UP = 74,

  // Arrow Keys
  DOWN = 75, LEFT = 76, RIGHT = 77, UP = 78,

  // Numpad
  NUM_LOCK = 79,
  KP_0 = 80, KP_1 = 81, KP_2 = 82, KP_3 = 83, KP_4 = 84,
  KP_5 = 85, KP_6 = 86, KP_7 = 87, KP_8 = 88, KP_9 = 89,
  KP_PLUS = 90, KP_PERIOD = 95, KP_DIVIDE = 96,
  KP_ENTER = 97, KP_EQUAL = 98, KP_MULTIPLY = 104, KP_MINUS = 107,

  // Function Keys
  ESCAPE = 120,
  F1 = 121, F2 = 122, F3 = 123, F4 = 124, F5 = 125,
  F6 = 126, F7 = 127, F8 = 128, F9 = 129, F10 = 130,
  F11 = 131, F12 = 132,
  F13 = 133, F14 = 134, F15 = 135, F16 = 136,
  F17 = 137, F18 = 138, F19 = 139, F20 = 140,
  F21 = 141, F22 = 142, F23 = 143, F24 = 144, F25 = 145,

  // Media Keys
  AUDIO_VOLUME_DOWN = 168, AUDIO_VOLUME_MUTE = 169,
  AUDIO_VOLUME_UP = 170,

  // Clipboard
  COPY = 172, CUT = 173, PASTE = 174,
}
```

### Mods

Modifier key bitfield.

```typescript
enum Mods {
  NONE     = 0,
  SHIFT    = 1 << 0,  // 0x01
  CTRL     = 1 << 1,  // 0x02
  ALT      = 1 << 2,  // 0x04
  SUPER    = 1 << 3,  // 0x08 - Windows/Command
  CAPSLOCK = 1 << 4,  // 0x10
  NUMLOCK  = 1 << 5,  // 0x20
}
```

### KeyAction

```typescript
enum KeyAction {
  RELEASE = 0,
  PRESS   = 1,
  REPEAT  = 2,
}
```

### KeyEvent

```typescript
interface KeyEvent {
  action: KeyAction;
  key: Key;
  mods: Mods;
  consumedMods?: Mods;
  composing?: boolean;
  utf8?: string;
  unshiftedCodepoint?: number;
}
```

### KeyEncoderOption

```typescript
enum KeyEncoderOption {
  CURSOR_KEY_APPLICATION = 0,       // DEC mode 1
  KEYPAD_KEY_APPLICATION = 1,       // DEC mode 66
  IGNORE_KEYPAD_WITH_NUMLOCK = 2,   // DEC mode 1035
  ALT_ESC_PREFIX = 3,               // DEC mode 1036
  MODIFY_OTHER_KEYS_STATE_2 = 4,    // xterm modifyOtherKeys
  KITTY_KEYBOARD_FLAGS = 5,         // Kitty protocol flags
}
```

### KittyKeyFlags

Kitty keyboard protocol flags.

```typescript
enum KittyKeyFlags {
  DISABLED           = 0,
  DISAMBIGUATE       = 1 << 0,
  REPORT_EVENTS      = 1 << 1,
  REPORT_ALTERNATES  = 1 << 2,
  REPORT_ALL         = 1 << 3,
  REPORT_ASSOCIATED  = 1 << 4,
  ALL                = 0x1f,
}
```

## Terminal Mode Types

### TerminalMode

```typescript
enum TerminalMode {
  // ANSI modes
  INSERT = 4,

  // DEC modes
  CURSOR_VISIBLE          = 25,
  MOUSE_TRACKING_NORMAL   = 1000,
  MOUSE_TRACKING_BUTTON   = 1002,
  MOUSE_TRACKING_ANY      = 1003,
  FOCUS_EVENTS            = 1004,
  ALT_SCREEN              = 1047,
  ALT_SCREEN_WITH_CURSOR  = 1049,
  BRACKETED_PASTE         = 2004,
}
```

## SGR Types

### SgrAttributeTag

Select Graphic Rendition attribute tags.

```typescript
enum SgrAttributeTag {
  UNSET = 0, UNKNOWN = 1,
  BOLD = 2, RESET_BOLD = 3,
  ITALIC = 4, RESET_ITALIC = 5,
  FAINT = 6, RESET_FAINT = 7,
  UNDERLINE = 8, RESET_UNDERLINE = 9,
  BLINK = 10, RESET_BLINK = 11,
  INVERSE = 12, RESET_INVERSE = 13,
  INVISIBLE = 14, RESET_INVISIBLE = 15,
  STRIKETHROUGH = 16, RESET_STRIKETHROUGH = 17,
  FG_8 = 18, FG_16 = 19, FG_256 = 20, FG_RGB = 21, FG_DEFAULT = 22,
  BG_8 = 23, BG_16 = 24, BG_256 = 25, BG_RGB = 26, BG_DEFAULT = 27,
  UNDERLINE_COLOR_8 = 28, UNDERLINE_COLOR_16 = 29,
  UNDERLINE_COLOR_256 = 30, UNDERLINE_COLOR_RGB = 31,
  UNDERLINE_COLOR_DEFAULT = 32,
}
```

## Link Types

### ILink

```typescript
interface ILink {
  text: string;
  range: IBufferRange;
  activate(event: MouseEvent): void;
  hover?(isHovered: boolean): void;
  dispose?(): void;
}
```

### ILinkProvider

```typescript
interface ILinkProvider {
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;
  dispose?(): void;
}
```

### IBufferCellPosition

```typescript
interface IBufferCellPosition {
  x: number;  // Column (0-based)
  y: number;  // Row (0-based, absolute buffer position)
}
```

## Terminal Config

### GhosttyTerminalConfig

```typescript
interface GhosttyTerminalConfig {
  scrollbackLimit?: number;  // Default: 10000
  fgColor?: number;          // 0xRRGGBB, 0 = default
  bgColor?: number;          // 0xRRGGBB, 0 = default
  cursorColor?: number;      // 0xRRGGBB, 0 = default
  palette?: number[];        // 16 ANSI colors in 0xRRGGBB
}
```

WASM config struct size: 80 bytes (4 + 4 + 4 + 4 + 64).
