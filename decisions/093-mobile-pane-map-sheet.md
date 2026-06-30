# 093 — Narrow-viewport pane-map "zoom-out" overview sheet

## Context

The narrow-viewport pane carousel (decisions 090/091) shows one zoomed tmux pane
at a time, so the user loses the **spatial** layout — where each pane sits in the
split. `dev3 ui state` already prints an ASCII box map of pane geometry for
agents; we wanted the same picture, tappable, on a phone.

## Investigation

The geometry was already computed: `pty-server.ts → getTmuxLayout(taskId)` returns
the windows + every pane's `pane_left/top/width/height/command/title`, but it was
only reachable through the CLI socket (`dev3 ui state`), not the renderer↔bun RPC.
So no new tmux parsing was needed — only an RPC surface.

`tmuxPaneNavigate` jumped by display **index** within the active window. Mapping a
map box back to an index is fragile if the map's snapshot and the navigate read
disagree on order, so a jump-by-id path is more robust.

**Zoom gotcha (the bug that made the first cut unusable):** the carousel keeps the
window *zoomed*. While zoomed, `list-panes` collapses the **active** pane's
`pane_left/top/width/height` to the full window (`L=0 W=full`) and leaves the other
panes overlapping it — so every box stacked in the top-left corner, labels piled up,
and the full-size active box swallowed all taps (you always "jumped" to the pane you
were already on). The fix: read geometry from each window's `window_layout` string,
which is **zoom-independent** (it still encodes the real split while zoomed). Verified
on live tmux, including non-contiguous pane ids after a kill-pane.

## Decision

- Added a thin `tmuxLayout({taskId}) → TmuxLayout` RPC (`rpc-handlers/tmux-pty.ts`)
  that reuses `pty.getTmuxLayout` with the session's own socket. No duplicated
  tmux logic; the CLI and the sheet read identical data.
- `getTmuxLayout` now derives pane geometry from `window_layout` via the new
  `parseWindowLayout` (zoom-independent — see Investigation), falling back to the
  per-pane fields only when a layout can't be parsed. This also fixes the latent
  same bug in the `dev3 ui state` ASCII map.
- Extended `tmuxPaneNavigate` with an optional `paneId` (select that exact pane),
  so the map jumps by id, not index.
- New `PaneMapSheet.tsx` (built on the mandated `BottomSheet`) renders the **active
  window's** panes as CSS-positioned boxes from geometry (percent of `winW/winH`;
  aspect ≈ `winW/(winH*2)` to match terminal cell shape, clamped). Tap → jump+zoom
  → close. When >1 window exists it lists windows **read-only** — the explicit
  foundation for a future windows switcher / +split / +window.
- Trigger is a single grid button added to the carousel's existing pane-control
  strip (only when multi-pane) — not a new global toolbar control, avoiding the
  project's toolbar-creep anti-pattern. Placement follows the narrow-viewport
  doctrine (BottomSheet primitive, terminal surface).

## Risks

- The map reflects the active window only; panes in background windows aren't
  jump targets yet (the windows switcher is deferred, per the task).
- Geometry boxes can be thin for lopsided splits; the whole box is the tap target,
  but a very narrow pane is a small touch area — inherent to a faithful mini-map.

## Alternatives considered

- **Expand the carousel inline into a grid** — rejected; breaks the one-sibling-at-
  a-time doctrine and offers no zoom-out affordance.
- **Build the full windows switcher + +split/+window now** — rejected; the task
  scopes this PR as the *foundation*, so windows are listed read-only.
- **Jump by index** — rejected in favour of jump-by-`paneId` for order-drift safety.
