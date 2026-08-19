# Terminal viewers ack their progress, and output past them is dropped

## Context

A command that repaints the whole screen at 60 fps (`term-bench --duration 20 --fps 60`)
made the terminal run as slow-motion video: the benchmark finished in 20 s of wall clock
while the pane was still painting its seventh second, and it kept going for ~40 s after
the process had exited. Every number looked fine — nothing was dropped, nothing errored.
That is the failure: `pty-backpressure.ts` states "nothing is ever dropped: the ANSI stream
is stateful", so a viewer slower than the shell can only fall further behind, forever.

## Investigation

Measured with the Debug → Terminal Performance overlay and the `pty-throughput` counters
added alongside it:

| Where | Rate |
|---|---|
| term-bench → tmux | 13 MB/s |
| tmux → its client | 1.9 MB/s (tmux coalesces ~6.9×) |
| tmux → our pty-server (`bytesIn`) | 2.4–6.3 MB/s |
| pty-server → socket (`bytesOut`) | 6.2 MB/s, `getBufferedAmount()` **0** |
| renderer consumed | 0.95 MB/s |

So the server was ~1–5 MB/s ahead of the renderer while both of its own gauges (`queued`,
`socketBuffered`) read near zero. Every socket in the chain is loopback, so the backlog was
sitting in the browser's own WebSocket receive path — invisible from bun, and invisible to
the renderer's probe, which can only count what it already processed.

Two fixes were unavailable. Real backpressure to tmux is impossible: `Bun.Terminal`
(`bun-types`, `class Terminal`) exposes `write`/`resize`/`setRawMode`/`ref`/`unref`/`close`
and **no `pause()`**, so we must keep draining the PTY and tmux never sees a slow client.
Widening the batch window (the existing mechanism) does not help either — it throttles the
message rate, not the byte rate, and the bytes still arrive.

`tmux refresh-client -t <client>` was verified against a real tmux before the design was
committed to: 286 bytes containing the on-screen text, against 0 bytes of idle noise.

## Decision

The renderer reports its position and the server drops past it.

1. **Ack protocol** — `src/shared/pty-flow-control.ts`. An OSC-style in-band sequence
   (`ESC ] dev3ack ; <total> BEL`), the same shape as the resize report, sent per message
   after `term.write()` returns. Cumulative, so a lost ack costs nothing. The pty-server
   intercepts it before the shell write (`message()` in `pty-server.ts`) — ahead of the
   shell lookup, so a dead shell cannot swallow the ack that releases a repaint.
2. **`sent - acked` is the backlog**, maximum across viewers (output is one broadcast, so
   the slowest decides). A viewer that has never acked is **skipped, not counted**: flow
   control is opt-in, and an older renderer keeps the old never-drop behaviour.
3. **Drop with hysteresis** — `flushPendingData` discards the batch above 512 KB
   outstanding and resumes below 64 KB (`shouldDropOutput`). One threshold would flap
   every flush.
4. **Repaint** — `repaintTmuxViewers` runs `tmux.listClients` + `tmux.refreshClient` for
   the session's own clients when the viewer is back under the resume mark. tmux holds the
   authoritative screen, which is what makes discarding stateful ANSI safe here.

**tmux only.** A native session's journal is the only screen a reconnecting viewer can
rebuild from, so a gap in it has nothing to repaint it — `flushPendingData`'s native branch
is unchanged and says so.

## Risks

- **Visible behaviour change:** under a flood the screen now jumps forward instead of
  replaying every frame. That is the goal, but it is a different picture than before.
- **Remote/tunnelled viewers** carry ack round-trip time inside the backlog, so a slow link
  reads as further behind than it is. 512 KB was chosen partly to absorb that; if a
  tunnelled session starts dropping while its viewer is keeping up, that threshold is why.
- **The repaint is best-effort.** A failed `refresh-client` leaves a stale screen until the
  next real output or resize. Throwing from the PTY read path would be worse.
- The ack prefix is swallowed rather than typed, so pasting that exact escape sequence is
  eaten. Same exposure the resize protocol already has.

## Alternatives considered

- **Pause the PTY under pressure** — the correct fix, and what Ghostty does. Not available:
  Bun's `Terminal` has no `pause`/`resume`.
- **Keep widening the batch window** — already in place, and demonstrably not enough: it
  bounds messages per second, not bytes, so the backlog grew anyway.
- **Measure the backlog server-side** — tried first, and it is what proved the point:
  `queued` and `socketBuffered` both read ~0 while the viewer was megabytes behind. The
  server cannot see past its own socket, so the renderer has to say.
- **Drop in the renderer instead** — it would still have to receive the bytes first, so the
  browser's receive queue keeps filling. The drop has to happen before the send.
- **Rebuild the screen with `capture-pane -e`** — loses cursor position, modes and the
  alternate screen. `refresh-client` makes tmux emit the correct stream itself.
