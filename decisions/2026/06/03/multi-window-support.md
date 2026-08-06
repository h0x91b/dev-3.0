# 044 — Multi-window support, macOS-style quit behavior

## Context

The single `mainWindow` pattern called `Utils.quit()` from the window-close
handler, so red-X on the window terminated the whole app. Users on multi-monitor
setups asked to keep a different project visible on each screen, which requires
at least (a) more than one window and (b) a quit model that survives closing
individual windows.

## Investigation

- Electrobun's `exitOnLastWindowClosed` defaults to `true`
  (`node_modules/electrobun/dist/api/bun/core/BrowserWindow.ts`, the global
  `electrobunEventEmitter.on("close", ...)` handler) — the last window closing
  auto-calls `quit()`. We set it to **`false`** in `electrobun.config.ts`
  (`runtime.exitOnLastWindowClosed`) to match real macOS apps: closing the last
  window keeps the app alive in the dock; it is reopened via the `reopen` event
  (dock-icon click → `openMainWindow` when window count is 0).
- `BrowserView.defineRPC` returns an rpc object whose `setTransport` is called
  once per view (`BrowserView.createStreams`). The same rpc instance cannot be
  reused across windows; each window gets its own rpc, but the handler
  implementations are shared.
- `Electrobun.events.on("before-quit", ...)` fires once per app shutdown and is
  the right place for global teardown (socket server, cloudflare tunnel,
  pollers).
- Electrobun's menu accelerators documented today only support single-character
  keys (Cmd-prefix automatic). Modifier chords like `Shift+N` aren't covered, so
  the File → New Window menu item carries no native accelerator. The Cmd+Shift+N
  shortcut is instead handled in the renderer (`App.tsx` `useGlobalShortcut`,
  capture phase) → `openNewWindow` RPC → `window-manager.openNewWindow()`, the
  same path the menu item uses. Renderer keydown handlers have no chord
  restriction.

## Decision

1. New module `src/bun/window-manager.ts` owns the registry, broadcasts push
   messages to every open window, tracks the focused window, and creates new
   windows (each with its own rpc instance).
2. `src/bun/index.ts` no longer constructs `mainWindow` directly. It calls
   `createAppWindow(...)` for the first window and again when the user picks
   File → New Window. The push-message callback and all PTY/port/resource
   event handlers broadcast via `broadcastToAllWindows`. Menu actions route
   through `sendToFocusedWindow` / `getFocusedWindow()`.
3. The per-window close handler no longer calls `Utils.quit()`. Global cleanup
   moved to `Electrobun.events.on("before-quit", ...)` so it runs exactly once,
   whether the user hits Cmd+Q, menu/dock Quit, or an update triggers a restart.
4. `runtime.exitOnLastWindowClosed = false` — closing the last window leaves the
   app in the dock. The `reopen` handler opens a fresh window when none exist.
   A deliberate quit while window-less reopens a window to host the React quit
   confirmation dialog (the reopened renderer pulls the pending flag on mount —
   see [061](061-quit-confirmation-before-quit-gate.md)).
5. `src/bun/application-menu.ts` adds `MENU_ACTIONS.newWindow` and a File → New
   Window item at the top of the File menu.

## Risks

- Opening the same task in two windows — both ghostty terminals subscribe to
  the same PTY session. Shared-keystroke races are possible but low-impact;
  users can avoid this by opening different projects per window.
- `getFocusedWindow()` falls back to any window if focus tracking drifts (e.g.
  a minimized window that never emits focus). Acceptable — menu actions still
  land somewhere rather than being dropped.
- With `exitOnLastWindowClosed = false` the app can sit window-less in the dock.
  If the `reopen` event ever fails to fire on a given platform, the user could be
  stuck with no way to get a window back short of quitting; mitigated on macOS
  where dock-click reliably emits `reopen`.

## Alternatives considered

- **Keep the single-window model, park two projects side-by-side in one
  window** — doesn't help multi-monitor users; they specifically want one
  project per screen.
- **Leave `Utils.quit()` in the close handler and have New Window call
  `Utils.quit()` guard** — fragile and non-native on macOS. Users expect the
  red X to close only that window.
- **Use `BrowserWindow`'s built-in map directly instead of a custom registry**
  — the custom registry gives us focus tracking and a single broadcast helper,
  worth the ~150 lines.
