# 059 — Quit confirmation via a single before-quit gate (React dialog)

## Context

The "sessions keep running" quit confirmation was only wired to the renderer's
Cmd+Q keyboard shortcut. Clicking the menu Quit item, or closing the last window
(which quits the app under multi-window — see [044](044-multi-window-support.md)),
bypassed it and exited silently, leaking background tmux sessions. We wanted one
confirmation covering every quit path, kept in React (native `showMessageBox`
would not work in the remote/browser client and we are moving away from native
dialogs).

## Investigation

- Electrobun's window `close` event fires *after* the native window is gone and
  is not preventable, so the red traffic-light X cannot be intercepted to show a
  dialog before the window closes.
- `before-quit` IS cancellable: `Utils.quit()` emits it synchronously and aborts
  if a handler sets `e.response = { allow: false }` (`node_modules/electrobun/dist/api/bun/core/Utils.ts`).
  It fires for every quit trigger, including `exitOnLastWindowClosed` and the
  updater relaunch.

## Decision

- New `src/bun/quit-manager.ts` holds a `quitConfirmed` flag shared between the
  gate and the `quitApp` handler.
- `src/bun/index.ts` `before-quit` gate: if already confirmed or `skipQuitDialog`
  is set, run cleanup and allow. Otherwise, **if a window is open**, cancel the
  quit and push `showQuitDialog` to the focused window. **If no window is open**
  (the user closed the last one with the X, which `exitOnLastWindowClosed`
  turns into a quit), allow the quit — we do NOT reopen a window to ask.
- `quitApp` (app-handlers) takes `{ dontShowAgain }`, persists `skipQuitDialog`
  to global settings, calls `markQuitConfirmed()`, then `Utils.quit()` — the
  second pass sails through the gate.
- Cmd+Q: WKWebView swallows the native menu Cmd+Q accelerator while a terminal
  has focus, so the renderer catches the keystroke (capture phase) and calls a
  new `requestQuit` RPC → `Utils.quit()` → the gate pushes `showQuitDialog` back
  to the same (still-open) window. Menu Quit / dock Quit reach the gate directly
  (those aren't keystrokes, so the webview doesn't eat them).
- `updater.applyUpdate()` calls `markQuitConfirmed()` first so auto-update
  relaunch is never blocked by the dialog.

## Risks

- Closing the **last** window quits without the "sessions keep running" dialog.
  This is deliberate: an earlier version reopened a window to host the dialog,
  but the reopen was jarring (window flashes back) and the deferred push raced
  the renderer mount so the dialog often never showed. The dialog now lives only
  on the explicit quit paths that have a window (Cmd+Q, menu, dock). tmux
  sessions persist regardless, so quitting never loses work.
- `skipQuitDialog` is a one-way opt-out from the dialog's checkbox; re-enabling
  needs a settings toggle (not yet added). Matches the previous localStorage
  behavior.

## Alternatives considered

- **Native `Utils.showMessageBox` in before-quit** — uniform and simplest, but
  native dialogs are wrong for the remote/browser client and we're removing
  native UI. Rejected.
- **Reopen a window on last-window-close to host the dialog** — implemented
  first, then removed: the reopen flashes a new window and the dialog push fired
  on `onDomReady` before the React listener mounted, so it was lost. Rejected.
- **Rely on the native `{ role: "quit" }` Cmd+Q accelerator** — the webview
  swallows it when a terminal is focused, so Cmd+Q did nothing. Rejected in
  favour of the renderer `requestQuit` forward.
