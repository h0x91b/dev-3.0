# Clear the inherited ghostty screen on attach, and gate it behind a blur in remote mode

## Context

In remote mode (`dev3 remote`, browser transport) entering a task showed the *previous*
task's terminal output for as long as the new session's redraw took to cross the tunnel —
hundreds of milliseconds to seconds, read by the user as the new task's own output.

## Investigation

Driven in a real browser (`agent-browser`) against a dev-server build, with PTY frames
held back 4 s by a `window.WebSocket` wrapper so the attach window could be inspected:

- The new `TerminalView` is a fresh mount (`key={taskId}` in `TaskWorkspacePane`), with a new
  `Terminal`, a new container and a new canvas node — the previous canvas was already gone
  from the DOM (`isConnected === false`).
- Yet with no PTY byte delivered, the fresh canvas rendered a full screen of the leaving
  task's output (`canvas.toDataURL().length` ≈ 217–274 KB against ≈ 27 KB for an empty one).
  So the leftover lives inside ghostty-web across `Terminal` instances, not in stale pixels
  of an orphaned node.
- `term.reset()` right after `term.open()` did not help: nothing repaints the canvas until
  something is written, so the inherited image stayed on screen.

## Decision

`src/mainview/TerminalView.tsx`:

1. **Clear through the write path.** `connectPty()` enqueues RIS (`\x1bc`) via
   `enqueueTermWrite`, the same batched path that repaints. Skipped when
   `nativeSeqRef.current !== null` — a native resume gets a delta that expects the screen it
   left behind.
2. **Sync gate, remote only.** `isRemote()` mounts a blurred overlay (`terminal.syncing`)
   over the canvas until the socket's own output lands, re-armed per socket so a mobile tab
   resume is covered too. It lifts on the first socket-delivered batch, on a final close, or
   after `TERMINAL_SYNC_GATE_TIMEOUT_MS` (2.5 s) so a silent session is never stuck blurred.
   Desktop never arms it: locally the redraw is one frame away and a flash of overlay is worse
   than none.
3. **`writeScheduled` flag** next to `writeRafId`: a `requestAnimationFrame` callback that
   runs before the call returns (the test stub does) left the id set forever, so every later
   batch queued unwritten. Scheduling is now guarded by the boolean, the id only cancels.

Only the socket's own bytes lift the gate (`pendingFromSocket`), so our own clear cannot.

## Risks

- The gate flashes for ~100 ms on a local browser session, where the redraw is fast. Accepted:
  the alternative (delaying the overlay) re-exposes the stale screen for exactly that window.
- RIS on every fresh attach discards a tmux pane's client-side scrollback view; tmux redraws
  the pane immediately after, and the scrollback lives in tmux, not in the canvas.

## Alternatives considered

- **Blur only, no clear** — the stale text stays readable through a 6 px blur, and blurred-but-
  legible output of another task is the same bug with extra steps.
- **`term.reset()` at open** — verified not to repaint (see Investigation).
- **Server-side clear or `capture-pane` replay on attach** — races tmux's own redraw; rejected
  before, see `decisions/2026/04/24/defer-initial-capture-pane-on-reconnect.md`.
