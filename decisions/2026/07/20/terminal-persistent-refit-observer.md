# 145 — Drive terminal fit ourselves instead of ghostty's observeResize

## Context

On a browser first-load (reported from Windows remote mode), the terminal
rendered only in the top part of the viewport with a large empty area below the
tmux status bar. Navigating away and back (e.g. clicking through a notification)
fixed it — a symptom that the terminal fitted to a wrong, small size on the very
first mount and never corrected until a remount.

## Investigation

`TerminalView` did one `fitAddon.fit()` then handed resize tracking to
`fitAddon.observeResize()`. In ghostty-web 0.4.0 (`node_modules/ghostty-web`),
`fit()` sets an internal `_isResizing` flag for **50ms**, and `observeResize()`'s
`ResizeObserver` callback early-returns while that flag is set. On a fresh
browser load the container's final flex growth routinely lands inside that 50ms
window, so the one resize callback that mattered is dropped and never retried —
the terminal stays stuck at the transient small size. In the desktop shell the
window opens at a stable size, so the first fit already sees the final height and
the bug does not surface.

## Decision

`TerminalView` (`src/mainview/TerminalView.tsx`) now keeps its own `layoutObserver`
`ResizeObserver` alive for the terminal's whole lifetime instead of disconnecting
it and delegating to `fitAddon.observeResize()` (which is no longer called).
Later size changes schedule a debounced (100ms) `refitToContainer()` that calls
`term.resize(proposeDimensions())` directly — `term.resize` is a no-op when
unchanged and carries **no** 50ms drop window, so a late growth always applies.
The one-shot initial setup is guarded by a `didInitialFit` flag; the debounce
timer is cleared on unmount.

## Risks

Our observer now re-fits on every container size change (window resize, zoom),
replacing ghostty's debounced observer. The 100ms debounce plus `term.resize`'s
unchanged-size short-circuit keep this from resizing the WASM terminal or
spamming the PTY on every animation frame during a drag.

## Alternatives considered

- Corrective re-fit only at WebSocket `onopen`: rejected — onopen can fire before
  layout settles on fast localhost, and it fixes only the connect path, not later
  growth.
- A fixed post-mount timeout re-fit (magic delay): rejected — fragile guesswork;
  a persistent observer handles every settle timing deterministically.
