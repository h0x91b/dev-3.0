# Input Handler

Handles keyboard events and converts them to terminal escape sequences using Ghostty's WASM KeyEncoder.

## Overview

The `InputHandler` bridges DOM keyboard events and the Ghostty WASM key encoder. It:

1. Captures keyboard events from the terminal's parent element
2. Maps DOM `KeyboardEvent` to Ghostty's `Key` enum
3. Encodes keys using Ghostty's WASM KeyEncoder (Kitty keyboard protocol)
4. Fires the encoded escape sequence via the `onData` callback

## Features

- Full keyboard mapping (writing keys, functional keys, modifiers, numpad, media)
- Kitty keyboard protocol support
- Application cursor mode (DEC mode 1)
- Custom key event handler support
- Mouse tracking (normal, button, any-event modes)
- SGR extended mouse mode
- Bracketed paste via hidden textarea
- Mobile keyboard support via textarea

## Key Mapping

DOM `event.code` values are mapped to Ghostty's internal `Key` enum:

| DOM Code | Ghostty Key | Notes |
|----------|-------------|-------|
| `KeyA`-`KeyZ` | `Key.A`-`Key.Z` | Writing keys |
| `Digit0`-`Digit9` | `Key.ZERO`-`Key.NINE` | Number row |
| `ArrowUp/Down/Left/Right` | `Key.UP/DOWN/LEFT/RIGHT` | Arrow keys |
| `Enter` | `Key.ENTER` | |
| `Backspace` | `Key.BACKSPACE` | |
| `Tab` | `Key.TAB` | |
| `Escape` | `Key.ESCAPE` | |
| `Space` | `Key.SPACE` | |
| `F1`-`F24` | `Key.F1`-`Key.F24` | Function keys |
| `Numpad0`-`Numpad9` | `Key.KP_0`-`Key.KP_9` | Numpad |
| `Home/End/PageUp/PageDown` | Corresponding keys | Navigation |
| `Insert/Delete` | Corresponding keys | Editing |

## Modifier Keys

```typescript
enum Mods {
  NONE     = 0,
  SHIFT    = 1 << 0,
  CTRL     = 1 << 1,
  ALT      = 1 << 2,
  SUPER    = 1 << 3,  // Windows/Command key
  CAPSLOCK = 1 << 4,
  NUMLOCK  = 1 << 5,
}
```

## Mouse Tracking

When the running application enables mouse tracking modes, the input handler:

1. Captures `mousedown`, `mouseup`, `mousemove` events on the canvas
2. Converts pixel coordinates to cell coordinates using renderer's font metrics
3. Encodes events as SGR extended mouse sequences (mode 1006)
4. Sends them via `onData`

Mouse tracking modes:
- Normal tracking (mode 1000) -- button press/release
- Button tracking (mode 1002) -- press/release + drag with button held
- Any-event tracking (mode 1003) -- all mouse events

## Custom Key Event Handler

```typescript
term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
  // Return true to prevent default terminal handling
  if (event.ctrlKey && event.key === 'c') {
    // Custom Ctrl+C behavior
    return true;
  }
  return false;
});
```

## Special Key Handling

- **Cmd+C** (macOS) / **Ctrl+Shift+C**: Copy selection to clipboard
- **Cmd+V** (macOS) / **Ctrl+Shift+V**: Paste from clipboard (via textarea)
- **Ctrl+C**: Sends ETX (`\x03`) to terminal
- **Alt+key**: Sends ESC prefix (`\x1b` + key)
- **Application cursor mode**: Arrow keys send `\x1bOA/B/C/D` instead of `\x1b[A/B/C/D`
