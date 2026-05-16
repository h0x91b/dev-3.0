# 049 — Click-to-open for watched-task notifications via activation events

## Context

Watched tasks emit a native notification on every status change
(`notifyWatchedTaskStatusChange` in `src/bun/rpc-handlers/shared.ts`).
The user expects that clicking the notification jumps straight into that task
inside dev-3.0. Out of the box this did nothing — the notification was
informational only.

## Investigation

Electrobun's `Utils.showNotification` is a thin wrapper around
`NSUserNotificationCenter` (macOS) / Shell balloon (Windows) /
`notify-send` (Linux). It does **not** expose a delegate or click callback
to JavaScript (see `vendor-docs/electrobun/apis/utils.md`). So there is no
way to attach an `onclick` handler directly to a notification raised by the
main process.

Two viable workarounds existed:

1. **Web Notifications API in the renderer** — `new Notification(...)`
   does support `onclick`, but WKWebView's support is uneven, requires a
   permission dance, and would need a different path for the remote-access
   browser client.
2. **App-activation heuristic** — when the user clicks a native
   notification on macOS, the app is activated, which triggers several
   AppKit events. If a watched-task notification fired in the recent past,
   we treat the activation as the click-through.

Option 2 is portable, needs no permission flow, and matches user intent in
the vast majority of cases.

First implementation only subscribed to `BrowserWindow.on("focus")`. That
event maps to `NSWindow.windowDidBecomeKey:`, which **does not re-fire** if
the window is already key but another app happens to be in front — exactly
the typical scenario for "click a notification while dev-3.0 is in the
background". Empirically, no activation log appeared in the main process
after three notification clicks. So one signal alone is not enough.

## Decision

- `notifyWatchedTaskStatusChange` records `{ taskId, projectId, timestamp }`
  in a module-level slot every time it fires a notification.
- A helper `consumeRecentWatchedNotification(now?)` reads and clears that
  slot, returning the target only if the entry is younger than
  `NOTIFICATION_CLICK_TTL_MS` (5 s). Both code paths (TTL hit / TTL miss)
  clear the slot so a stale entry can never bleed into a later activation.
- `src/bun/index.ts` subscribes to **two** activation signals:
  - `mainWindow.on("focus", ...)` — `windowDidBecomeKey:`
  - `Electrobun.events.on("reopen", ...)` — `applicationShouldHandleReopen:`
  Either signal calls `tryNavigateFromRecentNotification(source)`, which
  consumes the slot and pushes `openTaskFromNotification` to the renderer.
  Because the slot is one-shot, whichever signal arrives first wins; later
  signals find it empty and no-op.
- `src/mainview/App.tsx` listens for `rpc:openTaskFromNotification` and
  navigates to `{ screen: "task", projectId, taskId }`.

A `log.debug` line records every activation signal that arrives plus
whether a recent notification was queued — useful if this ever needs to be
diagnosed again.

## Risks

- **False positive**: if the user clicks the app's Dock icon (or otherwise
  activates dev-3.0) within 5 s of a watched notification, they are
  navigated even though they didn't click the notification. Recoverable
  via the back button; impact is low.
- **App already in foreground**: neither activation signal fires if the
  app is already active. The notification banner is informational and the
  Kanban already reflects the move via `rpc:taskUpdated`.
- **Multiple notifications in 5 s**: only the most recent target is kept
  (the slot is overwritten). Clicking a notification opens the task the
  user just saw it about.

## Alternatives considered

- **Web Notifications API in the renderer** — rejected for v1 because of
  WKWebView permission unknowns and the extra fallback path. Could be
  layered on top of this implementation later if needed.
- **Single-signal `focus` only** — what shipped first. Failed because
  `windowDidBecomeKey:` doesn't re-fire when the window was already key
  and the app was simply behind another app (the common notification case).
- **Fork Electrobun to expose a click delegate on `Utils.showNotification`**
  — too invasive for this scope; would require native code changes.
- **In-app toast banner on top of the native notification** — would require
  the user to click twice (notification → app → toast). Worse UX than the
  activation heuristic.
