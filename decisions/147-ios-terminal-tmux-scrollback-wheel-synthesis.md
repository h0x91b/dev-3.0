# 147 — iOS terminal: scroll tmux history by synthesizing SGR wheel events

## Context

On device, scrolling back through tmux pane history didn't work — a vertical drag
on the terminal moved nothing.

## Investigation

dev3's PTY always runs inside tmux started with `setw -g mouse on` (`pty-server.ts`),
which puts the outer terminal on the alternate screen and keeps SGR mouse tracking on
for the whole session (decision 098). Two consequences on iOS/SwiftTerm:

1. SwiftTerm's `TerminalView` is a `UIScrollView`; a vertical drag scrolls its **own**
   buffer. Under tmux (alternate screen) that buffer holds only the visible rows — there
   is no local scrollback — so dragging scrolls nothing.
2. dev3 sets `allowMouseReporting = false` (so taps/drags aren't all forwarded to tmux as
   mouse events). With reporting off, SwiftTerm's built-in pan sends **cursor-key**
   commands, not wheel events — never scrolling tmux history.

The web client hit the identical problem and fixed it by synthesizing wheel events on a
vertical drag (`TerminalView.tsx`). tmux with `mouse on` scrolls its history (entering
copy-mode) when the outer terminal forwards SGR mouse-wheel events.

## Decision

Add a `UIPanGestureRecognizer` to `Dev3SwiftTermView` (`Dev3TerminalView+Scroll.swift`)
that, on a **vertical** drag, synthesizes SGR 1006 wheel events and writes them to the
PTY via the existing input path: button 64 (wheel-up) when the finger drags down to reveal
older output, 65 (wheel-down) otherwise, at the touched cell. `Dev3TerminalScrollAccumulator`
turns fractional drag distance into whole wheel ticks (~24pt each) so a flick is a handful
of ticks. Native `isScrollEnabled` is turned **off** — under tmux it only rubber-bands an
unscrollable buffer. Horizontal drags are left to the pane-swipe gesture (axis lock at 8pt).
The pure encoding/accumulation logic (`Dev3TerminalWheelScroll`, `Dev3TerminalScrollAccumulator`)
is unit-tested; `allowMouseReporting` stays `false`, so taps and selection are unchanged.

**Gesture arbitration (build-4 follow-up):** the first cut didn't scroll on device. The scroll
pan was mutually exclusive with SwiftTerm's own recognizers (the `shouldRecognizeSimultaneouslyWith`
rule allowed only pinch), so it was starved. Fix: the scroll pan now recognizes **simultaneously
with every other recognizer**, and the built-in `UIScrollView.panGestureRecognizer` is disabled
outright (`isScrollEnabled = false` alone was unreliable). The scroll path also records to
`DiagnosticsLog` (`terminal` category: axis decision + each wheel tick) so on-device behavior is
inspectable via the Diagnostics screen.

## Risks

- A long-press-then-drag text selection and the scroll pan can both want the same drag;
  gesture arbitration favors one non-deterministically. Scrollback was the priority;
  selection-during-drag needs on-device QA.
- Sending wheel events assumes tmux `mouse on`; a bare PTY (no tmux) wouldn't scroll, but
  dev3 always runs tmux.

## Alternatives considered

- **`allowMouseReporting = true`** — makes SwiftTerm forward all taps/drags as mouse
  events (breaking tap-to-focus and turning drags into tmux selections), and still sends
  button-press/motion rather than wheel ticks. Rejected.
- **Enter tmux copy-mode via key sequences** (`C-b [`, PageUp) — brittle and mode-visible.
