# Display-configuration polling and the live frame clamp

## Context

Two field reports: after a monitor resolution change the app showed a black
terminal with content running past the window's right edge ("на любой задаче"),
and after a long sleep one user lost mouse interaction while the keyboard kept
working. The reporter confirmed a manual window resize does NOT fix it and that
a restart does — which is exactly the asymmetry described below. Changing the
resolution five times on a developer machine did not reproduce either symptom,
so the root cause is still unproven and no blind behavioural fix was written.

## Investigation

- Electrobun exposes **no** display-configuration event and **no** sleep/wake
  event. `Screen` is poll-only (`getAllDisplays()` → id / bounds / scaleFactor);
  window events are limited to move / resize / focus / blur / close.
- `resolveRestoreFrame` (`src/bun/window-state.ts`) already clamps a saved frame
  into the current display bounds — but only on startup. Nothing clamps a *live*
  window, which is a plausible reason a restart cures the symptom and a resize
  does not.
- `ghostty-web` captures `window.devicePixelRatio` in its renderer constructor and
  never re-reads it, and it repaints only dirty rows (a full redraw needs a screen
  switch, a resize, or an explicit force). A `term.resize` to unchanged cols/rows
  is a no-op, so nudging a window by a few pixels cannot restore a lost canvas.
- `refitToContainer` (`src/mainview/TerminalView.tsx`) swallowed every throw from
  `proposeDimensions` / `term.resize` in an empty `catch`, so a failed refit on a
  live terminal left no trace anywhere.

## Decision

`src/bun/display-watch.ts` polls the display layout every 5 s and reports either
`displays` (layout signature changed) or `wake` (a tick arrived more than 3×
late — timers do not run while asleep, and a sleep can end on the exact layout it
started with). `handleDisplayConfigurationChange` in `window-manager.ts` logs both
the window frame and the display bounds, and calls `offscreenFrameClamp` — which
pulls a window back **only** when part of it covers no display at all, measured
against the union of every display. The renderer mirrors its own geometry from
`src/mainview/viewport-diagnostics.ts`, so one log file holds both sides and the
next report arrives with evidence instead of hypotheses. The empty `catch` blocks
now log through the existing renderer diagnostic sink.

## Risks

- The clamp moves a user's window. Guarded by the union-coverage test plus a 2 px
  slack, so a window spanning two monitors and a hairline sliver are both left
  alone; a fullscreen window is never touched, because macOS owns its frame.
- Polling costs one FFI call per 5 s. Measured as noise next to the existing
  pollers, and the watcher writes nothing while the layout is stable.
- The reported symptoms may have another cause entirely. Nothing here claims to
  fix them; the diagnostics exist precisely because the cause is unproven.

## Alternatives considered

- **Resize nudge on a trigger** (the existing first-paint trick from
  `window-manager.ts`, replayed on display change). Dropped: the reporter says a
  manual resize does not help, and an unchanged cols/rows resize cannot force the
  canvas redraw the symptom needs.
- **"First size change in X minutes" heuristic** as the trigger. Dropped: it
  fires while the user drags a window edge after a quiet period, and misses two
  resolution changes in a row.
- **Clamping to the display containing the window's center, always.** Dropped:
  it would yank a window the user deliberately spanned across two monitors.
