# 041 — Drop `capture-pane` replay on WS reconnect

## Context

Switching between tasks produced a garbled terminal for the newly-activated
task: overlapping text, mis-aligned rows, and leftover characters that only
cleared after the user manually added a pane (which forces tmux to hard-
redraw). Adding a pane was a workaround, not a fix.

## Investigation

The PTY server keeps one long-lived tmux session per task. On WebSocket
reconnect (`src/bun/pty-server.ts` WS `open` handler) the server used to
call `capturePane()` immediately and send the result prefixed with
`\x1b[2J\x1b[H` so the user saw content instantly instead of a blank
terminal (introduced in PR #352 for the #234 flicker).

`tmux capture-pane -p -e` returns content at **tmux's current internal
pane size**. That size reflects whatever the last client (or the 80×24
spawn default) told tmux — not the freshly-measured dimensions of the
ghostty-web terminal the React tree just mounted. When the two sizes
differ, rendering stale-width lines into a terminal sized differently
produces exactly the "switch glitch" we saw. Tmux's SIGWINCH redraw
(triggered by the client's resize dance) only repaints changed cells and
cannot clean up the stale characters that sit in cells it does not touch.

A first attempt **deferred** the replay until after the client's resize
message propagated to tmux, with an 80 ms debounce. That fixed the glitch
but introduced noticeable flicker on every switch: clear on WS open,
then tmux's SIGWINCH redraw paints gradually, then 80 ms later another
clear+capture replay flashes over top. Two clears + a redraw + a replay
in ~130 ms is visually noisy.

## Decision

Drop the replay altogether. On WS reconnect (`src/bun/pty-server.ts`
WS `open`, reconnect branch) the server sends **nothing**. The React tree
mounts a fresh ghostty-web terminal which is already blank, and the
client's resize dance (cols-1 → cols, 50 ms apart) forces two SIGWINCHes
that make tmux emit a full pane redraw via the natural PTY data path.

That single redraw is the authoritative paint. No clear, no capture
replay, no competing flashes.

## Risks

- The "instant paint on reconnect" UX from #352 is gone. In practice the
  SIGWINCH redraw arrives within a few frames, so the previously-described
  flicker window is small; in exchange, switches are now glitch-free *and*
  free of the double-flash the deferred-capture attempt introduced.
- Relies on tmux always doing a full pane redraw on SIGWINCH. Tmux's
  `window_redraw_all_panes()` path does this; the client's resize dance
  guarantees the kernel forwards SIGWINCH even when the dimensions equal
  tmux's current size.

## Alternatives considered

- **Defer capture until after first resize (80 ms debounce).** Fixed the
  glitch but flickered on every switch; superseded by this decision.
- **Force a tmux full redraw via `refresh-client` / `send-keys -R`.**
  Requires a client target (tty), adds a subprocess spawn per resize, and
  still depends on tmux's output arriving via the PTY — no real gain over
  the SIGWINCH-only path.
- **Pass client dims in the WS URL so the server can resize tmux before
  capturing.** Cleanest conceptually, but the client only knows its
  dimensions after `FitAddon.fit()` runs, and threading that through the
  existing RPC-returned URL is more invasive than dropping the replay.
