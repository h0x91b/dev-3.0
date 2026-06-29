# 092 — Mobile touch controls for creating tmux panes & windows

## Context

On a narrow viewport (phone via `dev3 remote`, narrow window) panes/windows could
only be created via the `⌃B` prefix — impractical without a keyboard. The narrow
pane carousel (decision 090) only rendered chrome when a window already had >1 pane,
so from the common single-pane start there was no touch path to split at all
(violates the doctrine's "no feature touch-unreachable" rule).

## Decision

Added a "Panes & windows" button to `MobilePaneCarousel.tsx`'s top bar (now rendered
whenever the session has ≥1 pane, not only when multi-pane). It opens the mandated
`BottomSheet` with create actions — Split horizontally / Split vertically / New window —
plus Close pane (≥44px rows). All four reuse the existing `tmuxAction` RPC
(`splitH`/`splitV`/`newWindow`/`killPane`); no backend change was needed. After an
action we call `tmuxPaneNavigate({ zoom: true })` immediately so the new split / new
window's shell shows at once instead of waiting up to one 3s poll. Close-pane reuses
the desktop last-pane guard: `tmuxPaneCount` (session-scoped) + `confirm()` before a
`force: true` kill.

## Risks

- Single-pane windows now always show a slim top bar (~32px) on narrow — a deliberate
  cost for a reachable entry point. A floating overlay was rejected by decision 090
  (it hid the terminal's top line).

## Alternatives considered

- **Inline +split/+window buttons in the top bar** — rejected; with the prev/dropdown/
  next switcher it becomes a non-wrapping overflow row (doctrine §7 forbids it).
- **A dedicated window switcher UI + new `tmuxWindowList`/select RPC** — deferred as out
  of scope. `+window` is not a dead end: `setw -g mouse on` is set and the touch→mouse
  bridge forwards taps, so tapping a window name in the Catppuccin status bar already
  switches windows. A sheet hint (`panePager.windowHint`) points users there.
- **Reusing desktop `TaskTmuxControls`** — rejected; it is dense (layout menus, hover
  popovers) and lives in `TaskInfoPanel`, the wrong surface for the terminal carousel.
