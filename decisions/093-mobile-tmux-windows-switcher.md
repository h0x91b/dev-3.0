# 093 — Narrow-viewport tmux windows switcher

## Context

On a narrow viewport (phone via `dev3 remote`) the terminal carousel only handled
tmux **panes** within the active window (decisions 090/091). tmux **windows** —
separate workspaces in the same session, opened with `⌃B c` or by tooling — had
no mobile affordance: you could neither see nor switch between them on a phone.

## Decision

Added one RPC, `tmuxWindowNavigate` (`src/bun/rpc-handlers/tmux-pty.ts`), mirroring
`tmuxPaneNavigate`: it reads the session's window layout (`readWindowLayout` via
window-scoped `list-windows`), optionally `select-window`s next/prev (`:+`/`:-`,
which wrap) or an absolute window id, and returns the fresh
`{ count, activeIndex, labels }`. There is no zoom concept for windows — each
window is its own workspace; label = `window_name` (tmux auto-names a window after
its command, unlike `pane_title` which defaults to the hostname).

The frontend adds `MobileWindowCarousel.tsx`: a slim top bar — ‹ prev · named
dropdown · next › — rendered only when `count > 1`, **above** the pane bar
(window = outer workspace, pane = inner split). Unlike the pane carousel it has
**no swipe** (the terminal's horizontal swipe is already owned by the pane
carousel; a second swipe target would conflict) — buttons + dropdown only, plus
Arrow keys while the bar is focused (the pane carousel owns Arrow keys only when
*its* group is focused, so they never clash). It polls `tmuxWindowNavigate`
read-only every 3 s (windows open/close outside React).

`TaskTerminal` wraps the pane carousel in the window carousel and, on a window
switch, bumps a `refreshKey` passed to `MobilePaneCarousel` so the pane carousel
re-reads and re-zooms the newly-active window's panes immediately instead of
waiting up to one poll interval. `refreshKey` is just added to the pane carousel's
existing poll effect deps — `TerminalView` (the children) is untouched, so the
websocket never reconnects on a window switch.

## Risks

- One extra `list-windows` / 3 s per open narrow task — same cheap, constant cost
  the pane carousel already pays.
- Two stacked slim bars when both window and pane counts exceed 1. Acceptable: each
  bar only renders when its count > 1, so single-window (the common case) shows
  nothing new.

## Alternatives considered

- **Reuse the generic `tmuxAction` (`newWindow`/next-window)** — rejected; it
  returns void, but the switcher needs the layout back to render (same reason
  `tmuxPaneNavigate` exists, decision 090).
- **Generalise `MobilePaneCarousel` to handle both** — rejected; the pane carousel
  is heavy with terminal-canvas swipe/zoom logic that windows do not need, and the
  two have different semantics (zoom vs none, swipe vs none).
- **Allow swipe for windows too** — rejected; it would fight the pane swipe over
  the same terminal surface. Windows get an explicit bar instead.
