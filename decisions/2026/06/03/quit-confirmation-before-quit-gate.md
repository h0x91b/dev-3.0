# 061 — Quit confirmation via a single before-quit gate (React dialog)

## Context

The "sessions keep running" quit confirmation was only wired to the renderer's
Cmd+Q keyboard shortcut. Clicking the menu Quit item bypassed it and exited
silently, leaking background tmux sessions. We wanted one confirmation covering
every quit path, kept in React (native `showMessageBox` would not work in the
remote/browser client and we are moving away from native dialogs). Multi-window
([044](044-multi-window-support.md)) now runs with
`exitOnLastWindowClosed: false`, so the app can sit window-less in the dock and
still receive a quit (dock Quit / Cmd+Q) with no renderer to host the dialog.

## Investigation

- Electrobun's window `close` event fires *after* the native window is gone and
  is not preventable (response type `{}`, no `allow`; docs `events.md`,
  `windowEvents.ts`), so the red traffic-light X cannot be intercepted to show a
  dialog before the window closes.
- `before-quit` IS cancellable: `Utils.quit()` emits it and aborts if a handler
  sets `e.response = { allow: false }`. It fires for every quit trigger (Cmd+Q,
  menu, dock, signals, updater relaunch).
- With `exitOnLastWindowClosed: false`, closing the last window no longer quits,
  so the only way to reach a quit without a window is a *deliberate* quit while
  the app is window-less in the dock.

## Decision

- New `src/bun/quit-manager.ts` holds a `quitConfirmed` flag (gate ↔ `quitApp`)
  and a `quitDialogPending` flag (gate ↔ reopened renderer).
- `src/bun/index.ts` `before-quit` gate: if already confirmed or `skipQuitDialog`
  is set, run cleanup and allow. Otherwise cancel the quit and: **if a window is
  open**, push `showQuitDialog` to it; **if none is** (window-less in the dock),
  `markQuitDialogPending()` and `openMainWindow()`.
- The reopened window PULLS the flag on mount via the `consumePendingQuitDialog`
  RPC and shows the dialog. Pulling (not pushing) avoids the race where the gate
  pushed before the renderer's `rpc:showQuitDialog` listener had mounted — the
  bug that made the earlier reopen attempt look like "reopened with no dialog".
- `quitApp` (app-handlers) takes `{ dontShowAgain }`, persists `skipQuitDialog`,
  calls `markQuitConfirmed()`, then `Utils.quit()` — the second pass sails
  through the gate.
- Cmd+Q: WKWebView swallows the native menu Cmd+Q accelerator while a terminal
  has focus, so the renderer catches the keystroke (capture phase) and calls a
  new `requestQuit` RPC → `Utils.quit()` → the gate. Menu/dock Quit reach the
  gate directly.
- `updater.applyUpdate()` calls `markQuitConfirmed()` first so auto-update
  relaunch is never blocked by the dialog.

## Risks

- Quitting while window-less reopens a window to host the dialog — a brief flash
  before the dialog appears. Accepted as the only way to show a React dialog
  after the app went window-less (native window-close is not interceptable). The
  pull-on-mount handshake makes the dialog reliable (no lost push).
- `skipQuitDialog` is a one-way opt-out from the dialog's checkbox; re-enabling
  needs a settings toggle (not yet added). Matches the previous localStorage
  behavior.

## Alternatives considered

- **Native `Utils.showMessageBox` in before-quit** — uniform and simplest, but
  native dialogs are wrong for the remote/browser client and we're removing
  native UI. Rejected.
- **Push `showQuitDialog` to the reopened window from `onDomReady`** — raced the
  renderer mount and the message was lost. Replaced by the pull handshake.
- **Quit silently when window-less** (no reopen) — simpler and avoids the flash,
  but drops the "sessions keep running" warning on a real quit. Rejected: the
  user wants the warning on every deliberate quit even at the cost of the flash.
- **Rely on the native `{ role: "quit" }` Cmd+Q accelerator** — the webview
  swallows it when a terminal is focused, so Cmd+Q did nothing. Rejected in
  favour of the renderer `requestQuit` forward.
