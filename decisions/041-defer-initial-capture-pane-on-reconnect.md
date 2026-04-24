# 041 — Three fixes to eliminate the task-switch terminal glitch

## Context

Switching between tasks produced three distinct symptoms, all perceived as
"the terminal glitches on every switch":

1. **Garbled overlap** — stale-width text characters stuck behind the new
   task's content until the user manually added a pane.
2. **Flicker of the task being left** — the outgoing task's content
   visibly redrew, then blanked, then the new task appeared.
3. **"Refresh and realign"** — text shifted sideways between two rapid
   paints on each switch.

## Investigation

Each symptom had an independent root cause.

**(1) Garbled overlap.** On WS reconnect the PTY server immediately called
`capturePane()` and sent `\x1b[2J\x1b[H` + captured content so the user
saw content instantly (from PR #352 / issue #234). `tmux capture-pane`
returns content at **tmux's current internal pane size** — stale whenever
the previous client disconnected at a different size (or the session was
still at the 80×24 spawn default). Rendering stale-width lines into a
freshly-sized client terminal produced the overlap; tmux's SIGWINCH
redraw only repaints changed cells, so the leftover characters stuck
around.

**(2) Flicker of the leaving task.** `TaskTerminal` was not keyed by
`taskId`, so on every switch React re-ran the component with the new
`taskId` while the previous task's `ptyUrl` state was still in scope.
That caused `TerminalView` to remount *twice*: first with the stale URL
+ new taskId (repainting the leaving task into a freshly re-created
canvas), then again once the new URL arrived.

**(3) Refresh/realign.** The client-side resize dance nudged columns
(`cols-1` → `cols`) to force SIGWINCH on same-size reconnects. Tmux
emitted a full pane repaint at each size, and because column count
differs between the two paints, text re-wrapped at a narrower width and
then at the target width — a visible horizontal shift.

## Decision

Three independent fixes, committed together:

- **Drop the capture-pane replay.** `src/bun/pty-server.ts` WS `open`
  reconnect branch now sends nothing. React mounts a fresh ghostty-web
  terminal per switch (already blank), and the client's resize dance
  forces tmux's SIGWINCH full-pane repaint down the natural PTY data
  path. That single redraw is the authoritative paint.
- **Key `TaskTerminal` by `taskId`.** `src/mainview/components/
  TaskWorkspacePane.tsx` now renders `<TaskTerminal key={taskId} … />`,
  so a task switch fully unmounts the previous `TaskTerminal`, starts
  the new one with a null `ptyUrl`, and mounts `TerminalView` exactly
  once — after the new URL arrives.
- **Row-nudge the resize dance.** `src/mainview/TerminalView.tsx`
  `ws.onopen` now sends `(cols, rows+1)` then `(cols, rows)` (was
  `(cols-1, rows)` then `(cols, rows)`). Text wrapping is identical
  between the two paints, so the only visual difference is one extra
  blank bottom row that disappears on the second paint — effectively
  invisible.

## Risks

- The instant-paint-on-reconnect UX from #352 is gone. In practice the
  SIGWINCH redraw arrives within a couple of frames, so the previously-
  described flicker window is small.
- Keying `TaskTerminal` tears down the old task's Terminal + WS on every
  switch. This was already happening implicitly via prop changes, just
  twice instead of once — net resource cost is lower after this change.
- The row-nudge still causes two SIGWINCH/repaints in tmux; we rely on
  tmux's redraw of an identical-width pane being visually stable. If a
  future tmux version changes that behavior the dance may need to be
  reconsidered.

## Alternatives considered

- **Defer capture until after first resize (80 ms debounce).** Fixed
  symptom (1) but introduced double-flash flicker on every switch
  (clear on WS open + clear+capture after debounce). Superseded.
- **Force a tmux full redraw via `refresh-client` / `send-keys -R`.**
  Requires a client tty target and a subprocess spawn per resize; no
  real gain over the SIGWINCH-only path.
- **Pass client dims in the WS URL** so the server can resize tmux
  before capturing. Cleanest conceptually, but the client only knows
  its dimensions after `FitAddon.fit()` runs and threading that through
  the existing RPC-returned URL is more invasive than dropping the
  replay.
- **Keep all visited tasks mounted with CSS hide/show** for zero-flicker
  switching. A meaningful UX upgrade but a much bigger change (memory,
  multiple live WS connections, cache eviction policy). Deferred.
