# 060 — Shared PTY sizes to the smallest connected client

## Context

Multi-window ([044](044-multi-window-support.md)) lets the same task be open in
two app windows at once. Each window's terminal resizes the PTY independently,
and they flip-flopped: only the window that last sent a resize rendered
correctly; the other drew against the wrong geometry. Remote/browser viewers hit
the same path but the bug only surfaced with two simultaneous *desktop* windows.

## Investigation

- `pty-server.ts` keeps **one** `PtySession` per task with a single PTY
  (`session.proc.terminal`) and a `Set` of WebSocket clients. PTY output is
  broadcast to all clients; a resize message resized the one shared PTY —
  last-write-wins.
- `remote-access-server.ts` proxies `/pty?session=…` to the same internal PTY
  server, so remote is **not** a separate mechanism — it's just another client
  of the same shared PTY. "Remote works" only because that test had effectively
  one active client.
- A single PTY can only be one size, so two different-sized viewers can't each
  get a perfect fit — exactly how a tmux session shared by multiple real clients
  behaves (it sizes to the smallest; larger clients letterbox).

## Decision

- Track each client's last requested size on its WS object (`ptyCols`/
  `ptyRows`). On every resize message and on client disconnect, call
  `applyClientSizes()`, which resizes the shared PTY to the **min cols and min
  rows independently** across all clients (pure helper `smallestClientSize`,
  unit-tested).
- tmux does not emit a SIGWINCH/redraw on a same-size resize, so a newly
  connected *larger* viewer (which doesn't change the min) would never get its
  initial paint. When the target size is unchanged, `applyClientSizes` forces a
  redraw with a one-row jiggle (same trick as the WKWebView nudge in
  `window-manager.ts`). The session tracks `appliedCols`/`appliedRows` to detect
  this.

## Risks

- The jiggle briefly reflows existing viewers by one row on connect/disconnect.
  Imperceptible for typical TUIs and only fires on those rare events, not per
  keystroke.
- Smallest-wins means a large window is clamped to a small co-viewer's size
  while both are open. This is the inherent single-PTY trade-off and matches
  tmux's own multi-client behaviour.

## Alternatives considered

- **Per-connection `tmux attach` (one PTY per viewer).** The "correct" model —
  tmux negotiates size natively and each client renders independently. Rejected
  for now as a large, higher-risk refactor of the core PTY path (output is
  currently broadcast from one PTY; reconnection/replay assume one proc). Worth
  revisiting if smallest-wins proves too limiting.
- **Block opening the same task in two windows.** Sidesteps the issue but
  removes a legitimate multi-window use case. Rejected.
