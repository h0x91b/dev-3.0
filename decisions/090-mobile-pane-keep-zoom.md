# 090 — Narrow-viewport pane carousel: idempotent tmux keep-zoom

## Context

On a narrow viewport (phone via `dev3 remote`, or a narrow window) a task's tmux
window must show **one pane at a time** instead of a cramped split. The pager
(`MobilePanePager.tsx`) zooms the active pane and switches between panes. The
hard part is keeping a pane zoomed *across* a switch.

## Investigation

tmux `select-pane` **auto-unzooms** the window: you cannot "move to the next
pane while staying zoomed" in one command. Naively calling `resize-pane -Z`
(a toggle) before/after a move flickers or lands in the wrong state, especially
when a call is doubled (React Strict Mode, a poll racing a tap, a retry).

## Decision

Added one RPC, `tmuxPaneNavigate` (`src/bun/rpc-handlers/tmux-pty.ts`), that does
select-then-rezoom in a single round trip and returns the fresh layout
(`{ count, activeIndex, zoomed }`) for the pager UI:

1. `readPaneLayout` (window-scoped `list-panes`, NOT `-s`) for count/active/zoom.
2. If `step`/`index` given and `count > 1`: `select-pane` (auto-unzooms), re-read.
3. Enforce `zoom` intent **idempotently** — read the flag, `resize-pane -Z` only
   on a mismatch. So a doubled call never flips zoom the wrong way.

The frontend (`MobilePaneCarousel.tsx`) auto-zooms once on the first multi-pane
sighting (fulfils "open in zoom"), then polls read-only every 3 s, so it never
fights a user who manually un-zoomed. Single-pane sessions render no chrome and
trigger no zoom.

Pane switching is a **carousel swipe over the terminal** (the user asked for the
board's swipe paradigm here too), made TUI-safe by **axis arbitration in the
capture phase**: a clearly-horizontal drag is the carousel (preventDefault +
stopPropagation so the ghostty canvas never sees the move, plus a synthetic
`mouseup` to cancel the nascent selection); a vertical drag or a tap falls
through to the terminal untouched. A slim **non-overlapping** dots strip at the
top (off the on-screen keyboard; dots carry ~28px tap targets) and Arrow keys
are the accessible equivalents — browser QA showed a floating overlay pill hid
the terminal's top line and 6px dots were untappable, so it became a real strip.

## Risks

- The poll (one `list-panes` / 3 s per open task on narrow) is cheap but constant.
- Zoom is shared tmux window state: a second client attached to the same session
  sees the zoom too. Acceptable edge case.
- Leaving narrow does not auto-unzoom; the desktop split is restored by the
  existing zoom toggle / `⌃B z`. Deliberate — auto-unzoom-on-resize risked
  fighting the user for negligible benefit.

## Alternatives considered

- **`keepZoom` flag on the existing `tmuxAction`** — rejected; `tmuxAction`
  returns void and is fire-and-forget, but the pager needs the layout back.
- **Toggle-based zoom** (plain `resize-pane -Z`) — rejected; not idempotent,
  flips wrong under doubled calls.
- **A docked bottom pager bar** (first cut) — rejected after review; on mobile the
  bottom is where the on-screen keyboard + ExtraKeyBar live, so it was covered,
  and it broke the carousel paradigm. Replaced by the swipe + top dots above.
- **Naive full-surface swipe** (no arbitration) — rejected; would fight
  interactive TUIs (vim/htop/less) that consume touch. The capture-phase axis
  arbitration is what makes swipe-over-terminal safe.
