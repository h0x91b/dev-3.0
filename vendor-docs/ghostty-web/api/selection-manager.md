# Selection Manager

Handles text selection and clipboard operations in the terminal.

## Features

- Mouse-based text selection (click and drag)
- Double-click word selection
- Triple-click line selection
- Selection across scrollback content
- Copy to clipboard
- Select all
- Programmatic selection
- Selection change events

## SelectionManager

### Constructor

```typescript
new SelectionManager(
  terminal: Terminal,
  renderer: CanvasRenderer,
  wasmTerm: GhosttyTerminal,
  textarea: HTMLTextAreaElement
)
```

### Methods

#### `getSelection(): string`

Get selected text as string. Handles multi-line selections and scrollback content.

#### `hasSelection(): boolean`

Check if there's an active selection.

#### `clearSelection(): void`

Clear the current selection.

#### `copySelection(): boolean`

Copy selection to clipboard using `navigator.clipboard.writeText()`. Returns true if text was copied.

#### `selectAll(): void`

Select all text in the terminal (including scrollback).

#### `select(column: number, row: number, length: number): void`

Select text starting at column/row with given length.

#### `selectLines(start: number, end: number): void`

Select entire lines from start to end.

#### `getSelectionPosition(): IBufferRange | undefined`

Get selection coordinates as buffer range.

#### `dispose(): void`

Clean up event listeners and resources.

### Events

#### `onSelectionChange: IEvent<void>`

Fired when selection changes. Subscribe via the Terminal's `onSelectionChange`.

```typescript
term.onSelectionChange(() => {
  console.log('Selection:', term.getSelection());
});
```

## Selection Coordinates

Selections use absolute buffer coordinates (including scrollback offset). The selection manager converts between:

- **Viewport coordinates**: Relative to visible area (0 = top visible row)
- **Screen coordinates**: Relative to active screen buffer
- **Buffer coordinates**: Absolute (scrollback offset + screen position)

When the viewport is scrolled (`viewportY > 0`), selection handles both scrollback and screen content seamlessly.

## Interaction Model

| Action | Behavior |
|--------|----------|
| Click | Clear selection, set cursor |
| Click + drag | Select text |
| Double-click | Select word |
| Triple-click | Select line |
| Shift+click | Extend selection |
| Cmd+A / Ctrl+A | Select all |
| Cmd+C / Ctrl+C | Copy selection (if any) |

Selection is preserved when new terminal output arrives (unlike some terminals that clear on write).
