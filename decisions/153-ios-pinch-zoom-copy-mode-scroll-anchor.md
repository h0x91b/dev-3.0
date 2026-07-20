# 153 — Pinch-zoom pins the tmux copy-mode top line to keep scroll position

## Context
TestFlight feedback: pinching to zoom the terminal loses the user's place — the view jumps "lower"
(toward newer output). A previous fix (a678c0db) addressed row-clipping during the gesture but not the
position jump.

## Investigation
The terminal is SwiftTerm inside a shared tmux client; SwiftTerm's own scrollback is empty, so the
visible scroll position is entirely tmux copy-mode state (decision 147). A cross-check reproduced it
against a real tmux 3.6a client: the pinch already defers all remote resizes until gesture end
(`Dev3TerminalResizeGate`), so only ONE resize fires. On that resize's SIGWINCH, tmux preserves the copy
cursor's *content* line but resets the cursor to screen row 0, snapping the bottom-most visible line to
the top — the jump. `pane_in_mode` stays 1 (it does not exit copy-mode). Capturing/restoring a numeric
scroll offset is fragile because a column change rewraps history and shifts the offset.

## Decision
Right before the resize, move the copy cursor to the current TOP visible line via
`tmux send-keys -X <pane> top-line`. tmux's own cursor-line preservation then keeps that exact line
pinned across the reflow — reflow-safe, no offset math. Implemented as a new
`anchorCopyModeScroll(taskId)` RPC (`src/bun/rpc-handlers/tmux-pty.ts`, reusing the copy-mode pane scan
generalised into `sendCopyModeVerbInSession`), called from `TerminalTaskService.resize` (the single
resize choke point) inside the connection gate, before `endpoint.resize`, awaited so the anchor lands
before the SIGWINCH. Best-effort (`try?`) so it never blocks a resize, and it only targets panes with
`pane_in_mode == 1`, so zooming at the live prompt is untouched.

## Risks
Low. One extra cheap RPC (a `list-panes` + a `send-keys` per in-mode pane) per resize; no-ops when
nothing is scrolled back. Untouched: the resize gating/coalescing (a678c0db) and the wheel-synthesis
scroll path (147, 92f9cd42). Backend unit tests assert `top-line` is sent only to in-mode panes and
skipped otherwise; the live feel is simulator-verified once the desktop ships this backend.

## Alternatives considered
- **Capture/restore a numeric scroll offset:** fragile across column-change rewraps. Rejected in favor of
  `top-line`.
- **iOS-only throttle of mid-gesture font reflow:** does not fix the jump — the position lives in tmux and
  only moves on the single end-of-gesture resize. Rejected as insufficient.
- **iOS-only copy-mode commands over the PTY / wheel compensation:** unreliable (keytable-dependent; a
  synthesized click does not move the copy cursor) and risks scrolling into history at the live prompt.
  Rejected.
