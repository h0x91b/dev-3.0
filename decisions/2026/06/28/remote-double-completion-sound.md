# 084 — Completion sound plays once across all connected renderers

## Context
In remote mode the desktop app and a browser can both be connected to the same
backend (and on the same physical machine, sharing speakers). Completing or
cancelling a task played the sound twice.

## Investigation
Two sources play the sound: the UI plays it optimistically the instant a card is
dropped (`playTaskCompletionSound` in `src/mainview/task-sounds.ts`, called from
`moveTaskToStatus`), and the backend pushes a `taskSound` event
(`emitTaskSound` in `src/bun/rpc-handlers/task-lifecycle.ts`). The old de-dup
remembered the task id per renderer and swallowed the matching push — but that
state lives in each renderer's JS heap. The backend push fans out to EVERY
connected renderer (`broadcastToAllWindows` + `pushToBrowserClients` in
`src/bun/index.ts`), so only the initiating renderer suppressed its echo; every
other one had no token and played the push.

## Decision
The two playback paths are made mutually exclusive at the source. UI-initiated
terminal moves play locally and pass `clientPlayedSound: true` on the `moveTask`
RPC; `moveTask` then skips `emitTaskSound` entirely (no push to anyone). Non-UI
completions (CLI, branch-merge auto-complete, agent approval) never set the flag,
so the backend push remains the single sound. The per-renderer echo machinery
(`expectedEchoes` / `markEchoExpected` / `isEchoExpected`) is removed.

## Risks
Non-UI completions still broadcast `taskSound` to all renderers, so a CLI /
branch-merge / agent-approval completion can still double on one machine with two
renderers connected. Accepted: those paths have no single initiating renderer to
own the sound, and the reported issue was manual complete/cancel.

## Alternatives considered
- Backend nominates a single renderer (focused window, else one browser) for the
  push: covers the non-UI paths too, but needs dedicated single-target routing in
  the window manager and remote server — more surface area and risk.
- Drop the optimistic local play and rely solely on a single-target backend push:
  most unified, but sacrifices the deliberately-instant local feedback.
