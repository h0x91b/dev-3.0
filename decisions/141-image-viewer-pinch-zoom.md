# 141 — Pinch-zoom / pan in the shared-image viewer via Pointer Events

## Context
On mobile / remote-browser the shared-image lightbox (`TaskImageViewer`) only offered
fit/width toggling. Small screens made captures unreadable with no way to zoom into detail.

## Decision
Added `src/mainview/hooks/usePinchZoom.ts` — a Pointer Events based hook (touch + mouse/
trackpad, identical in desktop and browser). Two pointers pinch-zoom around their midpoint,
one pointer pans once zoomed, double-tap toggles fit↔2.5×, ctrl-wheel (trackpad pinch)
zooms toward the cursor. The transform math is two pure, unit-tested functions
(`clampTransform`, `zoomAt`); the hook is thin wiring around them. Wired into
`TaskImageViewer` only in `fit` mode (tall images keep vertical scroll) with
`touch-action: none` on the stage so the browser doesn't hijack the gesture.

## Risks
Pointer capture / `touch-action` differ subtly across engines; guarded with optional chaining
and only enabled in `fit` mode so scrollable tall images are untouched. Gesture wiring is
hard to fully exercise in happy-dom — covered by pure-function tests plus a ctrl-wheel
component test; genuine multi-touch pinch is verified manually on device.

## Alternatives considered
- `react-zoom-pan-pinch` library — rejected, avoids a dependency for ~120 lines.
- Native CSS `touch-action: pinch-zoom` on a scroll container — rejected, inconsistent in
  WKWebView and no control over bounds / double-tap / reset-on-navigation.
