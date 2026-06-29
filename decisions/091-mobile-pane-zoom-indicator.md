# 091 — Pane zoom indicator instead of auto-un-zoom on entry

## Context

tmux zoom is shared, per-window state (decision 090). The narrow-viewport carousel
zooms a window to one pane; that zoom leaks to the desktop split and to any other
client on the same session, and `⌃B z` gives no obvious "you are zoomed / here is
the way out" affordance. The ask was to stop mobile zoom from silently degrading
the desktop view and make the zoom state legible.

## Investigation

Two mechanisms were considered: (a) auto-un-zoom the full app on entry, and
(b) a visible badge with a one-tap un-zoom. Decision 090 already **rejected**
auto-un-zoom (on resize) as fighting a deliberate zoom. Auto-un-zoom on *entry*
has the same failure modes: it overrides a desktop `⌃B z` whenever the task view
re-mounts (board↔task navigation), and — because zoom is shared — it yanks the
one-pane view out from under a phone client attached to the same session.

## Decision

Added `PaneZoomBadge` (`src/mainview/components/PaneZoomBadge.tsx`), rendered only
in the **non-narrow** `TaskTerminal` branch. It polls `tmuxPaneNavigate` read-only
(no `zoom`/`step`/`index` → pure read, guarded by `typeof params.zoom === "boolean"`
in the handler) every 3 s and, when a multi-pane window is zoomed, shows a small
floating "Zoomed" pill (top-right, `fullscreen_exit` glyph). Tapping it calls
`tmuxPaneNavigate({ zoom: false })`. We deliberately do **not** auto-un-zoom: the
shared view is mutated only on an explicit tap. The narrow carousel still owns the
mobile one-pane view (badge is absent there — zoom is intended).

## Risks

- One extra `list-panes` / 3 s per open desktop task. Cheap but constant (same
  cost the carousel already pays on narrow).
- A leftover zoom is surfaced, not auto-corrected — the user must tap once. This is
  the intended trade-off (legible + reversible beats silent mutation).

## Alternatives considered

- **Auto-un-zoom on full-app entry** — rejected; fights deliberate `⌃B z` and breaks
  a concurrent phone client (see Investigation).
- **Rely on tmux's native status `Z` flag** — rejected; the Catppuccin status bar's
  zoom hint is easy to miss and offers no click-to-restore.
- **Backend zoom-provenance marker** (un-zoom only mobile-set zoom) — rejected as
  out of scope ("small, no new backend"); needs a tmux user-option round trip.
