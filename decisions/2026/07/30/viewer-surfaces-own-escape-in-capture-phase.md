# 181 — Viewer surfaces own Escape in the capture phase

## Context

Escape while the artifact viewer (`TaskArtifactViewer`) or the image lightbox
(`TaskImageViewer`) was open did two things at once: the viewer closed *and* the app
navigated out of the whole task workspace back to the board. Exiting the viewer's
fullscreen had the same effect — one keypress, two layers gone.

## Investigation

Both viewers registered a plain bubble-phase `window` keydown listener. So does the
app-level Escape handler in `App.tsx` (`useGlobalShortcut`, default `capture: false`).
Same target, same phase → order is registration order, and `App` is the root, so **the
app handler always runs first**. It matched `route.screen === "project" && route.activeTaskId`
and navigated away before the viewer's handler ever saw the event.

That also rules out the obvious fix: an `if (e.defaultPrevented) return;` guard in the
app handler is dead code, because nothing has had a chance to call `preventDefault()` yet.

## Decision

The open viewer owns the keys it handles. Both viewers now register their keydown
listener with `{ capture: true }` and call `event.stopPropagation()` on every branch they
act on (`TaskArtifactViewer` — Escape / ArrowLeft / ArrowRight; `TaskImageViewer` —
Escape / arrows / Home / End / `f`). The app-level handler is left untouched and simply
never sees a consumed key.

`TaskArtifactViewer` keeps its focus gate (`fullscreen || viewerRef.contains(activeElement)`),
so a docked artifact panel does not swallow Escape for the rest of the app. It also
returns *without* consuming arrows while its find bar is open, so the query caret keeps
them. See bible §10 (`find in content`).

## Risks

- Capture phase means these listeners now preempt every other renderer shortcut while the
  viewer is mounted. Intended for a modal lightbox; scoped by the focus gate for the
  docked artifact panel.
- `TaskImageViewer` has no focus gate, so while it is open its keys (including bare `f`)
  are global. That was already true in bubble phase — only the ordering changed.

## Alternatives considered

- **`e.defaultPrevented` guard in `App.tsx`** — impossible, the app handler runs first.
- **Marker-attribute bails in `App.tsx`** (it already bails for `helpMode` and terminal
  focus; the lightbox even sets `data-image-viewer="open"`). Rejected: it puts knowledge of
  every nested surface into the root handler and needs a new marker per surface, whereas
  capture + stopPropagation keeps the rule local to the surface that owns the key.
