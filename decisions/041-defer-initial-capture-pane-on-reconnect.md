# 041 — Defer `capture-pane` replay until after the client's first resize

## Context

Switching between tasks frequently produced a garbled terminal for the
newly-activated task: overlapping text, mis-aligned rows, and leftover
characters that only cleared after the user manually added a pane (which
forces tmux to hard-redraw). Adding a pane was a workaround, not a fix.

## Investigation

The PTY server kept one long-lived tmux session per task. On WebSocket
reconnect (`src/bun/pty-server.ts` WS `open` handler) the server immediately
called `capturePane()` and sent the result prefixed with `\x1b[2J\x1b[H` so
the user saw content instantly instead of a blank terminal (introduced in
PR #352 to fix the #234 flicker).

`tmux capture-pane -p -e` returns content at **tmux's current internal pane
size**. That size reflects whatever the last client (or the 80×24 spawn
default) told tmux — not the freshly-measured dimensions of the ghostty-web
terminal that just mounted in the React tree. When the two sizes differ,
rendering stale-width lines into a terminal sized differently produces
exactly the "switch glitch" we saw. Tmux's SIGWINCH redraw (triggered by the
client's resize dance) only repaints changed cells and can't clean up the
stale characters that sit in cells it doesn't touch.

## Decision

Defer the capture-pane replay until after the client's resize message has
propagated to tmux. In `src/bun/pty-server.ts`:

- WS `open` (reconnect branch): send `\x1b[2J\x1b[H` immediately and flag
  the WS via `needsInitialCapture = true`. Do **not** call `capturePane`
  yet.
- WS `message` (resize branch): after forwarding the resize to the PTY,
  call `maybeScheduleInitialCapture(ws, sessionId)`. That helper debounces
  `INITIAL_CAPTURE_DEBOUNCE_MS` (80 ms) so the two-stage resize dance
  (`cols-1` then `cols`, 50 ms apart) collapses into a single replay at
  the final dimensions.
- WS `close`: clears any pending `captureTimer` so a late replay can't
  fire on a closed socket.

A regression test covers the happy path, the debounce, the
readyState-guarded early close, and the "capture returns empty" case.

## Risks

- During the ~130 ms deferral window the client sees tmux's natural SIGWINCH
  redraw flow through the normal PTY data path rather than an immediate
  replay. In practice the redraw arrives well before 130 ms, so there is no
  perceptible blank moment.
- `ws` is typed as `any` for the flag/timer fields, matching the pattern
  already used for `sessionId` and `sendText`. If the WS object is ever
  reused across reconnects the flags must be reset — currently Bun hands
  us a fresh WS for each connection, so this is safe.

## Alternatives considered

- **Remove the capture replay entirely** and rely only on SIGWINCH. Simpler
  but re-introduces the #234 flicker (brief blank terminal before tmux
  redraws) on every task switch.
- **Force a tmux full redraw via `refresh-client` / `send-keys -R`.**
  Requires a client target (tty), adds a subprocess spawn per resize, and
  still depends on tmux's output arriving via the PTY — no real gain over
  the SIGWINCH-only path.
- **Pass client dims in the WS URL query string** so the server can resize
  tmux *before* capturing. Cleanest conceptually, but the client only knows
  its dimensions after `FitAddon.fit()` runs, and threading that through the
  existing RPC-returned URL is more invasive than the debounce approach.
