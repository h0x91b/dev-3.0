# Draw the terminal cursor only on frames where it changes

## Context

Issue #1949: on Linux (WebKitGTK 2.50.4) an idle task terminal kept `WebKitWebProcess` at 40–100% CPU, and the window froze under agent output. While `cursorBlink` is on, ghostty-web 0.4.0's `CanvasRenderer.render()` repaints the cursor's whole row on every rAF frame (`if (cursorMoved || this.cursorBlink)`) and redraws the cursor on top. The blink phase only flips every 530 ms.

## Investigation

Measured in Docker: Ubuntu 25.04 arm64, the reporter's exact WebKitGTK 2.50.4, Xvfb, software GL. Each run was 30 s of `/proc` CPU sampling of `WebKitWebProcess`, 3 interleaved rounds, on an idle-page harness running the real ghostty-web `Terminal`:

- vendor behaviour: 150–159%;
- masking only the row repaint: 87–91%;
- `cursorBlink: false`: 153–158%;
- drawing nothing on unchanged frames: 13–16%.

`cursorBlink: false` issues a single `fillRect` per frame and still costs as much as the full row. So on WebKitGTK the cost is **any** canvas draw in a frame, not how much is drawn. In headless Chromium the counts were 9.6k → 160 `fillText`/s and 183 → 3 `fillRect`/s.

## Decision

`src/mainview/terminal-cursor-focus.ts` keys every frame on whether and where the cursor is drawn: blink phase × focus gate × DECTCEM × viewport at bottom × style × position.

- **Unchanged key:** it masks the private `cursorBlink` for that one `render()` call, so the vendor skips the row repaint. It also skips `renderCursor` while the cursor's pixels are still on the canvas.
- **Damage:** the gate wraps `renderLine` and `renderScrollbar`. A repaint of the cursor's row, or any scrollbar pass, marks the pixels damaged and forces the next draw.
- **Transitions** (blink, blur, focus, move) always paint, so the hidden cursor still disappears on the next frame.
- **Failure:** a frame that throws resets the state, and a buffer that cannot report its cursor falls back to vendor behaviour.

## Risks

- It depends on more undocumented internals: the private fields `cursorBlink`, `cursorVisible`, `cursorStyle`, and the fact that `renderCursor`, `renderLine` and `renderScrollbar` are the only paths that touch the cursor's pixels.
- A ghostty-web upgrade that paints over the cursor some other way would leave it missing until the next blink transition (≤ 530 ms). `src/mainview/__tests__/terminal-cursor-focus.test.ts` drives the real `CanvasRenderer` for idle, blink, blur, move, dirty-row and scrollbar frames.
- Absolute CPU on real hardware is unmeasured. The Docker numbers are ARM64 with software rendering.

## Alternatives considered

- **Turn blinking off (globally, or on Linux)** — measured as no cheaper than the bug, and it breaks the focus gate's erase path.
- **Patch the vendor bundle** — lost on every ghostty-web upgrade, and the repo has no patch mechanism for it.
- **Cache `ctx.font` per cell** — reduces style work only on frames that still draw. That cost is not the dominant one here.
