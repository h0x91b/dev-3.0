# macOS window frames flip against the window's own screen

## Context

h0x91b/dev-3.0#1872: on a 2560x1440 primary plus a 1440x2560 portrait screen, a
window parked on the lower half of the portrait screen jumped up "to the center"
every half hour or so, size unchanged. Nothing in dev3 recenters a live window
except `handleDisplayConfigurationChange`, which runs `offscreenFrameClamp` on
every `displays` or `wake` report from `display-watch`.

## Investigation

- Electrobun 1.18.1 `nativeWrapper.mm` (unchanged on upstream main, checked
  2026-10-09): `getWindowFrame` / `setWindowFrame` / `setWindowPosition` turn
  Cocoa's bottom-left y into top-left using `[window screen].frame.height`, while
  `getAllDisplays`, `createWindow` and the move/resize callbacks use the PRIMARY
  screen's height. On a screen whose height differs from the primary's, getFrame's
  y is off by `screenHeight - primaryHeight` (1120 px for the reporter).
- So the clamp saw the reporter's on-screen window as ~87% below the portrait
  screen, "pulled it back", and setFrame's own flip subtracted 1120 again — the
  window landed ~150 px from the top, which is what the issue screenshot shows.
- The cadence is the trigger, not the cause: on a single-display dev machine the
  log held 22-25 `wake` reports a day, several minutes apart, while `pmset -g log`
  showed no sleep or wake in those hours — timer stalls, not sleeps. Each one runs
  the clamp; with correct coordinates it is a no-op for an on-screen window.

## Decision

`window-state.ts` gains `nativeFrameYOffset` / `nativeFrameToGlobal` /
`globalFrameToNative`. The native side never says which screen it flipped against,
so we pick the display whose flip puts the window mostly on that same display (the
NSWindow.screen rule); no consistent reading falls back to the primary. On macOS
`window-manager.ts` reads and writes every frame through `readFrame` / `writeFrame`,
so the clamp, the persisted session and the dom-ready frame re-apply all work in
global coordinates. Other platforms are untouched.

## Risks

- A window split across two screens of different heights could be attributed to
  the wrong one; ties go to the reading with more on-screen area. Same-height
  layouts (the common case) are an exact identity.
- Sessions saved by older versions hold the shifted y for such windows; they clamp
  once on restore and are saved correctly afterwards. The file format is unchanged.
- Not verified on a real mixed-height multi-monitor Mac; the native behaviour is
  read from Electrobun's source and covered by unit tests with the reporter's layout.

## Alternatives considered

- **Skip the clamp on `wake`.** Hides the symptom on this trigger only; a real
  display change, session save and restore would still use the wrong y.
- **Patch Electrobun's native wrapper.** The right long-term fix (an upstream
  issue is worth filing), but it needs a native rebuild of the vendored dylib.
- **Track the global origin from move events.** They carry correct coordinates,
  but a window that has not moved since creation has no event to learn from.
