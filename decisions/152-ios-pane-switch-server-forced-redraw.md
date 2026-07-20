# 152 — Pane/window switch forces a server-side tmux redraw; iOS stops wiping locally

## Context
TestFlight build 8: switching tmux panes on iOS showed a blank (or stale) terminal
("Can't view tmux pane content"). All viewers of a task share ONE tmux client (a single PTY,
`pty-server.ts` `tmux new-session -A`), so pane/window switches are server-side tmux commands, not
per-client.

## Investigation
Commit a678c0db (shipped in build 8) tried to fix an earlier *stale* pane by having the iOS client, on a
pane-switch refresh revision, call `resetToInitialState()` (wipe its screen) then a same-size resize to
"force" a redraw (`Dev3TerminalView.requestRemoteRedraw`). Two problems: (1) a same-size resize emits no
tmux SIGWINCH, so it does not reliably redraw; (2) the destructive local wipe and the incoming repaint
are ordered by two independent async hops (network select-pane redraw vs. SwiftUI-revision → reset →
resize) with no guarantee — the wipe can land after fresh bytes and leave the screen blank. So the fix
converted *stale* into *blank*. tmux itself only repaints on a geometry change; `applyClientSizes`
already relies on this with a proven "one-row jiggle" (resize rows−1, +16 ms back to rows) to paint a
freshly-connected viewer.

## Decision
Make the repaint **server-authoritative and deterministic**. New `pty-server.forceSessionRedraw(taskId)`
reuses the one-row jiggle on the shared session; `tmuxPaneNavigate`/`tmuxWindowNavigate` call it as the
last step **only when the active pane, its zoom, or the active window actually changed** (a `didChange`
flag), so `PaneZoomBadge`'s read-only zoom polls never trigger a needless repaint. A full tmux redraw
uses absolute cursor positioning + line clears, so it overwrites any stale pane content cleanly — the
client no longer needs to wipe. `Dev3TerminalView.requestRemoteRedraw` now only
`discardPending()`s pre-switch frames and `setNeedsDisplay`; the `resetToInitialState()`/same-size resize
are removed.

## Risks
The forced repaint runs on the shared session, so a desktop viewer watching the same task sees a brief
reflow when a mobile client switches panes — acceptable (it is already seeing the switch). Client and
server halves ship together; a new iOS build against an old desktop degrades to the pre-a678c0db *stale*
behavior (not blank), which is strictly better than the regression. Guarded unit tests cover
"redraw on real switch, not on poll" (`rpc-handlers.test.ts`).

## Alternatives considered
- **iOS-only: reset before awaiting paneNavigation** so the natural select-pane/zoom redraw is the last
  write — weaker (the natural redraw was already insufficient → the original stale bug) and still
  client-timing-dependent. Rejected in favor of the server-forced full repaint.
- **Keep the client same-size resize jiggle** — unreliable (no SIGWINCH on same size) and drove the
  shared PTY from the client. Rejected.
