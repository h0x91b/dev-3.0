# 049 — Click-to-open for watched-task notifications via window focus

## Context

Watched tasks emit a native notification on every status change
(`notifyWatchedTaskStatusChange` in `src/bun/rpc-handlers/shared.ts`).
The user expects that clicking the notification jumps straight into that task
inside dev-3.0. Out of the box this did nothing — the notification was
informational only.

## Investigation

Electrobun's `Utils.showNotification` is a thin wrapper around
`NSUserNotificationCenter` (macOS) / Shell balloon (Windows) / `notify-send`
(Linux). It does **not** expose a delegate or click callback to JavaScript
(see `vendor-docs/electrobun/apis/utils.md`). So there is no way to attach an
`onclick` handler directly to a notification raised by the main process.

Two viable workarounds existed:

1. **Web Notifications API in the renderer** — `new Notification(...)` does
   support `onclick`, but WKWebView's support is uneven and would require a
   permission dance plus a different path for the remote-access browser
   client. More moving parts, more states to handle.
2. **Window-focus heuristic** — when the user clicks any native notification
   on macOS, the target app is activated, which fires `BrowserWindow`'s
   `focus` event. If a watched-task notification fired in the recent past,
   we treat that focus as the click-through.

Option 2 is portable (works for every notification path Electrobun supports),
needs no permission flow, and matches user intent in the vast majority of
cases.

## Decision

- `notifyWatchedTaskStatusChange` records `{ taskId, projectId, timestamp }`
  in a module-level slot every time it fires a notification.
- A new helper `consumeRecentWatchedNotification(now?)` reads and clears that
  slot, returning the target only if the entry is younger than
  `NOTIFICATION_CLICK_TTL_MS` (5 s). Both code paths (TTL hit / TTL miss)
  clear the slot so a stale entry can never bleed into a later focus event.
- `src/bun/index.ts` subscribes to `mainWindow.on("focus", ...)`. When the
  helper returns a target, the main process pushes
  `openTaskFromNotification` to the renderer.
- `src/mainview/App.tsx` listens for `rpc:openTaskFromNotification` and
  navigates to `{ screen: "task", projectId, taskId }`.

## Risks

- **False positive**: if the user clicks the app's Dock icon (or otherwise
  focuses the window) within 5 s of a watched notification, they are
  navigated even though they didn't click the notification. Recoverable via
  the back button; impact is low.
- **App already in foreground**: the `focus` event does not fire if the
  window is already key. In that case the user has nothing to click anyway
  — the notification banner is informational and the Kanban already
  reflects the move via `rpc:taskUpdated`.
- **Multiple notifications in 5 s**: only the most recent target is kept
  (the slot is overwritten). Acceptable — clicking a notification opens the
  task the user just saw it about.

## Alternatives considered

- **Web Notifications API in the renderer** — rejected for v1 because of
  WKWebView permission unknowns and the extra fallback path. Easy to add
  later on top of this implementation if needed.
- **Fork Electrobun to expose a click delegate** — too invasive for this
  scope.
- **In-app toast banner on top of the native notification** — would require
  the user to click twice (notification → app → toast). Worse UX than the
  focus heuristic.
