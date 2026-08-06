# 101 — Two-step visual Close Pane picker (overlay over the terminal)

## Context
The red "Close Pane" button (`TaskTmuxControls`) killed tmux's *active* pane — the
user couldn't see which pane would die, so an accidental click closed the wrong one.
We wanted a deliberate, spatial pick: hover the exact pane, see it armed in red, click
to close it.

## Investigation
The terminal is a single ghostty-web canvas; tmux draws its own splits inside it, so
there are no per-pane DOM elements to hover. But the app already reads zoom-independent
pane geometry (cells) via `tmuxLayout`/`getTmuxLayout` (`parseWindowLayout`) — the same
data `PaneMapSheet` uses to draw a mini-map. We overlay hit-boxes over the real terminal
using that geometry (cells → % of the container), the same math as the mini-map.

## Decision
- New `ClosePanePicker` overlay (`src/mainview/components/ClosePanePicker.tsx`), mounted
  in `TaskTerminal`'s `relative isolate` container so it clips to the terminal and its
  z-index (z-30, above `PaneZoomBadge`'s z-20) stays local. NOT portaled to `document.body`.
- Decoupled trigger via a `window` CustomEvent (`src/mainview/close-pane-picker.ts`,
  `CLOSE_PANE_PICKER_EVENT`): the toolbar button and the native "Close Pane" menu item
  (`menuRouter`) dispatch it; the overlay listens, scoped by `taskId`.
- New `tmuxKillPane({ taskId, paneId, force? })` RPC (`rpc-handlers/tmux-pty.ts`) kills a
  pane by id (`kill-pane -t %N`), validates the `%N` shape, keeps the last-pane guard and
  `handlePaneExited` cleanup that `tmuxAction("killPane")` has.
- `TmuxWindowInfo` gains `zoomed` (from `#{window_zoomed_flag}`): a zoomed window shows
  only its active pane on screen, so the picker draws ONE full-cover hit-box for it instead
  of the hidden multi-pane geometry.
- Narrow/mobile (no hover, one-pane carousel) keeps the old direct-kill fallback.

## Visual language
Hit-boxes **tile edge-to-edge**: each pane rect grows half a cell toward its
neighbours (clamped to the window) so adjacent boxes meet at the 1-cell divider
midpoint with no geometry gap. A single small uniform **inset** (`inset-[6px]`) is
then the only gutter — it lands right on the divider and stays even across panes.
(The earlier per-box `inset-[10px]` over raw, non-tiling rects stacked the divider
gap + double inset into big, uneven gaps — the thing this fixes.)

**Vertical status-bar offset.** Pane geometry (`window_layout`) is the WINDOW and
excludes the tmux status bar, but the rendered canvas includes it. So `getTmuxLayout`
also reports `statusLines` (= `client_height - window_height`, robust to multi-line
status) and `statusAtTop`, and the picker maps vertical positions over the FULL canvas
height (`winH + statusLines`), shifting down by the status bar when it's on top.
Without this every row landed slightly too low and the bottom pane overshot into the
status line (horizontal has no equivalent reservation). Idle
state is **neutral** (accent/blue) with an animated "marching ants" border (pure-CSS
`.dev3-marching-ants` in index.css, `currentColor`-driven, honors `prefers-reduced-motion`)
to signal interactivity WITHOUT alarming red; only the hovered/focused pane turns
**danger red** with a fill + "Close · <cmd>" chip. The mode hint is a solid high-contrast
pill (`bg-overlay/95`) so it stays readable over any terminal output.

## Risks
- Overlay position is container-relative %, but the ghostty grid is floored, so the canvas
  is up to ~1 cell smaller than the container. Hit-boxes can extend ~1% past real content —
  acceptable for a highlight; not pixel-perfect. Measuring the canvas was rejected as
  over-engineering for v1.
- We do NOT auto-unzoom the shared window on entry (would fight a deliberate `⌃B z` /
  attached phone client — see decision 091); instead we honor zoom by picking the visible pane.

## Alternatives considered
- A dropdown list of panes to close — rejected: loses the "which one on screen" spatial
  mapping the user asked for.
- A persistent per-pane close affordance — rejected: toolbar/control creep (the project's
  top UX anti-pattern).
