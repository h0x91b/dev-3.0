# 075 — Task hint badges track cards via synchronous DOM writes

## Context
The Vimium-style task hint overlay (`src/mainview/components/TaskHintOverlay.tsx`)
renders each badge in a fixed, viewport-anchored portal. The first version
recomputed positions on scroll by bumping React state (`bumpReposition`), forcing
a re-render that re-read `getBoundingClientRect()`. The browser repaints the
scrolled board immediately but the React render lands a frame or two later, so
badges visibly "chased" their cards — janky.

## Decision
Drop the state-driven reposition. Keep a `Map<taskId, HTMLSpanElement>`
(`badgeRefs`) populated by each badge's `ref` callback, and a `reposition()`
that writes `el.style.top/left` straight to the DOM. The `scroll`/`resize`
listeners call it directly (no `setState`), so positions update synchronously in
the event handler before paint. Render-time inline style still seeds correct
positions on mount and on typed-prefix re-renders.

## Risks
`reposition` mutates DOM React doesn't own, but React never fights it: re-renders
only happen on mount / typed change, and at those moments the render-time rect is
fresh, so the value React sets matches the current scroll position.

## Alternatives considered
- **CSS anchor positioning** (`anchor-name`/`position-anchor`): zero JS, native
  tracking — but unsupported in WKWebView (Safari engine) where the desktop app
  runs, and unreliable in remote-browser mode. Rejected.
- **Portal the badge into the card element**: scrolls natively, but kanban
  columns clip with `overflow`, so a corner badge would be cut off. The fixed
  overlay exists precisely to avoid that. Rejected.
- **Re-scan targets on scroll** (so cards below the fold get hints): deferred —
  regenerating the prefix-free hint set mid-session would reshuffle labels while
  the user is typing. Left for a separate change.
