# Interfaces

xterm.js-compatible TypeScript interfaces.

## ITerminalOptions

Constructor options for the Terminal class.

```typescript
interface ITerminalOptions {
  cols?: number;                  // Default: 80
  rows?: number;                  // Default: 24
  cursorBlink?: boolean;          // Default: false
  cursorStyle?: 'block' | 'underline' | 'bar';
  theme?: ITheme;
  scrollback?: number;            // Default: 10000 (was 1000 in xterm.js)
  fontSize?: number;              // Default: 15
  fontFamily?: string;            // Default: 'monospace'
  allowTransparency?: boolean;    // Default: false
  convertEol?: boolean;           // Convert \n to \r\n (default: false)
  disableStdin?: boolean;         // Disable keyboard input (default: false)
  smoothScrollDuration?: number;  // Duration in ms for smooth scroll (default: 100, 0 = instant)
  ghostty?: Ghostty;              // Internal: WASM instance for test isolation
}
```

## ITheme

Terminal color theme.

```typescript
interface ITheme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;

  // ANSI colors (0-15)
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}
```

### Default Theme

```typescript
const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};
```

## IDisposable

```typescript
interface IDisposable {
  dispose(): void;
}
```

## IEvent<T>

Event subscription function. Returns IDisposable to unsubscribe.

```typescript
type IEvent<T> = (listener: (arg: T) => void) => IDisposable;
```

## ITerminalAddon

Interface for terminal addons.

```typescript
interface ITerminalAddon {
  activate(terminal: ITerminalCore): void;
  dispose(): void;
}
```

## ITerminalCore

Minimal terminal interface for addons.

```typescript
interface ITerminalCore {
  cols: number;
  rows: number;
  element?: HTMLElement;
  textarea?: HTMLTextAreaElement;
}
```

## IBufferRange

Buffer range for selection coordinates.

```typescript
interface IBufferRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}
```

## IKeyEvent

Keyboard event with key and DOM event.

```typescript
interface IKeyEvent {
  key: string;
  domEvent: KeyboardEvent;
}
```

## IUnicodeVersionProvider

```typescript
interface IUnicodeVersionProvider {
  readonly activeVersion: string;  // '15.1' for Ghostty
}
```

## Buffer API

### IBufferNamespace

```typescript
interface IBufferNamespace {
  readonly active: IBuffer;        // Currently active buffer
  readonly normal: IBuffer;        // Normal buffer (primary screen)
  readonly alternate: IBuffer;     // Alternate buffer (fullscreen apps like vim)
  readonly onBufferChange: IEvent<IBuffer>;
}
```

### IBuffer

```typescript
interface IBuffer {
  readonly type: 'normal' | 'alternate';
  readonly cursorX: number;        // 0-indexed
  readonly cursorY: number;        // 0-indexed, relative to viewport
  readonly viewportY: number;      // Scroll offset
  readonly baseY: number;
  readonly length: number;         // Total buffer length (rows + scrollback)

  getLine(y: number): IBufferLine | undefined;
  getNullCell(): IBufferCell;
}
```

### IBufferLine

```typescript
interface IBufferLine {
  readonly length: number;
  readonly isWrapped: boolean;

  getCell(x: number): IBufferCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}
```

### IBufferCell

```typescript
interface IBufferCell {
  getChars(): string;
  getCode(): number;
  getWidth(): number;              // 1 = normal, 2 = wide/emoji, 0 = combining

  getFgColorMode(): number;
  getBgColorMode(): number;
  getFgColor(): number;
  getBgColor(): number;

  isBold(): number;
  isItalic(): number;
  isUnderline(): number;
  isStrikethrough(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isFaint(): number;

  getHyperlinkId(): number;        // 0 = no link
  getCodepoint(): number;
  isDim(): boolean;
}
```
