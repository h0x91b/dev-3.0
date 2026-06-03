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
- `src/bun/index.ts` `before-quit` gate: if not confirmed and `skipQuitDialog`
  setting is off, cancel the quit and push `showQuitDialog` to the focused
  window. If no window remains (last window just closed), reopen one and fire the
  push from its `onDomReady` (`pendingQuitDialog`).
- `quitApp` (app-handlers) takes `{ dontShowAgain }`, persists `skipQuitDialog`
  to global settings, calls `markQuitConfirmed()`, then `Utils.quit()` — the
  second pass sails through the gate.
- The renderer no longer intercepts Cmd+Q; native Cmd+Q / menu Quit reach the
  gate. The React dialog is opened by the `rpc:showQuitDialog` push.
- `updater.applyUpdate()` calls `markQuitConfirmed()` first so auto-update
  relaunch is never blocked by the dialog.

## Risks

- Closing the **last** window then cancelling reopens a fresh window (loses prior
  route state) — acceptable, and the only way to host a React dialog after the
  window is gone.
- `skipQuitDialog` is a one-way opt-out from the dialog's checkbox; re-enabling
  needs a settings toggle (not yet added). Matches the previous localStorage
  behavior.
- If `before-quit` fires while the only window's renderer is mid-load, the push
  could be missed and the quit stays cancelled. Rare; user can retry.

## Alternatives considered

- **Native `Utils.showMessageBox` in before-quit** — uniform and simplest, but
  native dialogs are wrong for the remote/browser client and we're removing
  native UI. Rejected.
- **Renderer-only Cmd+W interception** — keeps the React dialog but cannot cover
  the red-X-on-last-window path (native close is not interceptable). Rejected as
  incomplete.
