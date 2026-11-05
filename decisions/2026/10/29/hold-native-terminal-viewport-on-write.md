# Hold the native terminal viewport on write

## Context

ghostty-web's `writeInternal` calls `scrollToBottom()` on every write while `viewportY !== 0`. On a native-backend task the agent writes several times a second (spinner), so a reader in history, or a ⌘F match, snaps back to live output at once. A tmux task is not affected: tmux owns its history.

## Decision

`writeHoldingViewport` (`src/mainview/terminal-scroll-hold.ts`) reads `getViewportY()` and `getScrollbackLength()` before the write and calls `scrollToLine(viewportY + growth)` after it, so the same rows stay on screen (`viewportY` counts rows from the bottom). A write that carries a history clear (`ESC[3J`, RIS) is not held, and the captured `viewportY` is clamped to the scrollback because `reset()` leaves it stale. `TerminalView.handleNativeFrame` uses it for every native frame except one that resets the screen; at the bottom nothing changes and the view follows output. Input on a native pane (`followLiveOutput`: keys, paste, extra-key bar, drops, alt-click; not SGR mouse reports) scrolls to the bottom, as a normal terminal does, because the write no longer does it.

## Risks

- A full scrollback prunes whole pages, so the length drops while output was added. The hold then restores `viewportY + max(growth, 0)`: the view drifts by at most the evicted rows and does not snap to the bottom.
- During a smooth-scroll animation the private `targetViewportY` is not shifted, so the view can lag the anchor by the rows written in that frame.
- Smooth-scrolling down during dense output can park the view at a fractional `viewportY` slightly above the bottom, so the history state stays on until the user scrolls once more.
- A keypress within the ~50 ms smooth-scroll animation after a wheel-up can be undone by the running animation, because its target (`targetViewportY`) is private.
- Each held write fires two scroll events (to the bottom, then back). `TerminalView` reports only the final history state (`holdingViewport`), because `TaskTerminal` keeps one scrolled-up pane key and a background pane's transient `false` hid the focused pane's button. Other subscribers still see both: an OSC 8 hover tooltip hides on every write and the scrollbar does not fade while output flows.

## Alternatives considered

- Patch `writeInternal` in the vendored `ghostty-web-0.4.0-dev3.N` archive: needs a new archive and hashes (`patches/ghostty-web/README.md`) for a behaviour the public API can already restore.
- Monkeypatch `scrollToBottom` during a write: reaches into the vendored instance and also blocks a scroll the user asked for.
