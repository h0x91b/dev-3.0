# Rebuild the terminal when ghostty-web's render loop dies

## Context

Users reported a terminal pane that showed nothing while the agent kept working:
"на любой задаче", not a freeze, and immune to a window resize or a fullscreen
toggle — only restarting the app helped. The geometry diagnostics added the day
before (`display-change-poll-and-live-frame-clamp`) caught it on the first day.

## Investigation

Two crashes, both arriving through `term.resize` from `refitToContainer`:

- `2026-08-18 10:19:17` — `RangeError: Arguments contain a value that is out of
  range of code points`, at `cols: 257`, right after a PTY reconnect. The draw
  path calls `String.fromCodePoint(cell.codepoint || 32)` with no range guard,
  while the sibling `getChars()` in the same bundle does guard. Five more of these
  sit in the logs on 08-15 and 08-16.
- `2026-08-18 11:18:11` — `RuntimeError: Out of bounds memory access` at
  `cols: 158`, triggered by dragging the artifact panel. 116 traps followed, frame
  paced (a scrollbar-fade loop re-renders and re-throws), and eventually
  `ghostty_terminal_resize` itself trapped: the WASM terminal is gone, not just
  the frame.

Why it is permanent: `startRenderLoop` schedules the next frame only *after*
`renderer.render()` returns, with no try/catch, so one throw ends the loop for
good — and the method is private, so nothing outside can restart it. Upstream main
has since wrapped `resize` in try/catch and cancels the loop around it (its
comment names "detached TypedArray views"), but the loop body is still unguarded
and **there is no release after v0.4.0**, so a version bump cannot fix it.

## Decision

`recoverFromRendererCrash` in `src/mainview/TerminalView.tsx` rebuilds the pane:
the three `catch` blocks in `refitToContainer` bump a `terminalGeneration` that the
terminal effect depends on, so the old Terminal is disposed and a fresh one (fresh
WASM handle) attaches, with tmux repainting into it. Budget: 3 rebuilds, reset
after 60 s of health, then a toast offering `window.location.reload()` — the only
cure left if the shared WASM module itself is corrupt.

## Risks

- A rebuild costs a reattach (tmux repaint) and drops local canvas scrollback
  state. Acceptable against a permanently blank pane.
- If a rebuilt terminal dies instantly, the budget stops the loop after 3 tries;
  the toast is the escape hatch rather than an automatic page reload, which would
  be a big hammer to fire without the user's knowledge.
- The bad codepoint / OOB access itself is upstream and stays unfixed here.

## Alternatives considered

- **Restart the render loop instead of the terminal.** Impossible from outside:
  `startRenderLoop` is private, and in the WASM-trap case even
  `ghostty_terminal_resize` traps, so re-rendering could not help anyway.
- **Vendor or pin ghostty-web's main.** Gets upstream's try/catch but takes us off
  a released version onto a moving target, and leaves the loop body unguarded.
- **Auto-reload the window on the first crash.** Cures it, but throws away every
  pane's state for a fault that one pane rebuild usually fixes.
