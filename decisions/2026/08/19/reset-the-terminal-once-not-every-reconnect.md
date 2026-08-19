# Reset the terminal screen once per Terminal, not on every reconnect

## Context

From 2026-08-15 panes started dying: blank canvas, PTY and tmux alive, only a restart
brought them back. Two signatures, both from inside ghostty's WASM module —
`RangeError: Arguments contain a value that is out of range of code points` (a garbage
codepoint sitting in a cell, hit by the draw path) and `RuntimeError: Out of bounds
memory access`, the latter also out of `ghostty_terminal_write` on the very next batch.

## Investigation

The breadcrumb trail added in #1409 killed the standing theory: in all four captured
crashes the ring covered the pane's entire life (37 s, 1316 s, 31 s, 359 s) with no
`resize` and no `dpr` crumb at all. Geometry was never involved; the earlier
occurrences only *looked* resize-triggered because `term.resize` was the single place
we had a catch.

What the evidence did point at:

- The signatures appear in no log before `2026-08-15 20:43`, across every log going
  back to February.
- `ghostty-web` is pinned at `0.4.0` with an unchanged `sha512` in `bun.lock` since
  March, so the vendor did not move.
- Only two of our commits in that window touch the terminal. The other (#1360) is
  keyboard-shortcut plumbing.
- #1353 (`ddc019d6c`, 14 Aug) added `enqueueTermWrite("\x1bc")` — RIS, a full terminal
  reset — to `connectPty`, so it ran on every tmux socket **re**connect: every resume
  from background, every socket churn. The canary carrying it reached the machine
  ~25 h before the first crash.
- Every captured crash follows a `WS connected` by 8–37 s, and the trail's `visible`
  crumb is that same reconnect.

## Decision

`connectPty` in `src/mainview/TerminalView.tsx` now writes RIS at most once per
Terminal instance, guarded by an effect-scoped `screenResetForThisTerminal`. The reset
exists because a freshly constructed ghostty Terminal paints the pixels the previous
one left behind — that is a property of **constructing** a Terminal, not of opening a
socket, and a reconnect reuses the same instance. A rebuilt terminal re-runs the effect
and earns a fresh reset. `TerminalView.test.tsx` covers it: one RIS after the first
connect, still one after a hide/show cycle.

## Risks

Correlation, not yet a proven mechanism: the crash lands seconds after the RIS, so the
killer could equally be the tmux full redraw that the same reconnect triggers. Logs
cannot separate the two. The machine sees 2–6 crashes a day with full diagnostics, so
24–48 h of canary silence is the verdict. Should a stale screen reappear on resume, the
correct fix is a targeted repaint request to tmux, never a reset of the emulator.

## Alternatives considered

- **Keep the RIS and swallow the fallout.** #1406's guard already rebuilds a dead pane,
  so the symptom is survivable — but it left the user watching terminals blink several
  times a day.
- **Revert #1353 entirely.** Would bring back the real bug it fixed (task B showing
  task A's screen until its first redraw). The bug was the *frequency*, not the reset.
- **Build an isolated ghostty-web harness and hammer RIS until it crashes.** Real proof
  and a gift to upstream, but hours of work while a one-line gate can be measured in
  production within a day. Still worth doing if the silence does not arrive.
