# Hide the terminal cursor while input goes elsewhere

## Context

ghostty-web blinks the cursor forever, regardless of focus. Reading an artifact and
then dictating a prompt, the user watched a blinking cursor, assumed the terminal was
listening, and lost the whole dictation to the artifact iframe. A blinking cursor is
the strongest "type here" signal a terminal has, so it must be true.

## Investigation

`CanvasRenderer` exposes `setCursorStyle`/`setCursorBlink` but no unfocused-cursor
concept, and `cursorVisible` is private. Two vendor facts decided the shape:

- The cursor is drawn only when `buffer.getCursor().visible && this.cursorVisible`.
- While `cursorBlink` is on, the cursor's row is repainted on **every** frame of the
  rAF loop (`if (cursorMoved || this.cursorBlink)`), then the cursor is drawn on top.

So disabling blink would freeze the last painted cursor on screen — the opposite of
the goal — while lying about `visible` drops it within one frame, no forced repaint.
Theme swapping was rejected too: ghostty warns and ignores `options.theme` after
`open()`.

## Decision

`src/mainview/terminal-cursor-focus.ts` wraps `renderer.render` and, while gated,
hands it a Proxy of the buffer whose `getCursor().visible` is `false`. `TerminalView`
installs it **before** the bidi wrapper (`uninstallBidiRender` restores whatever
render it wrapped, so a gate on top would be silently removed by the bidi settings
toggle) and drives it from `inputReachesTerminal()`: window focused **and**
`activeElement` inside the terminal container. `focusout` re-reads on the next frame,
because it fires before the next element takes focus. Touch compose mode is exempt —
there the composer owns the keyboard and the terminal never holds focus.

## Risks

- Focus on `<body>` (right after clicking a kanban card) hides the cursor even though
  the printable-key handler would forward the keystroke to the terminal. Accepted: the
  first keystroke restores focus and the cursor, and the opposite error is the bug
  being fixed.
- The wrapper depends on undocumented vendor internals; a ghostty-web upgrade that
  stops repainting the cursor row per frame would leave a stale cursor behind.
  `src/mainview/__tests__/terminal-cursor-focus.test.ts` drives the real
  `CanvasRenderer` and asserts no cursor rect is painted, so that would fail loudly.

## Alternatives considered

- **Dim/grey cursor instead of hiding** — user chose hiding; a dim cursor still reads
  as an input affordance at a glance.
- **Hollow cursor (xterm.js style)** — requires a vendor renderer change.
- **CSS on the terminal element** — the cursor is canvas pixels, unreachable from CSS.
