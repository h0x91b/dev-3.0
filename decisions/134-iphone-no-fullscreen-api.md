# 134 — iPhone Safari has no Fullscreen API; mobile fullscreen is Android-only

## Context

The mobile remote overhaul (decision [133](133-remote-cookie-session-auth.md))
added a first-tap fullscreen auto-engage plus a Fullscreen toggle in the mobile
menu (`src/mainview/fullscreen.ts`, `GlobalHeader.tsx`) to reclaim the screen
space eaten by browser chrome. It works on Android Chrome. On iPhone it does
nothing — verified live on a physical iPhone.

## Investigation

iPhone Safari has **no Fullscreen API for arbitrary DOM elements**, by Apple's
deliberate choice — not a bug we can work around:

- Prefixed/iPad-only historically; Safari 16.4 unprefixed the API on macOS and
  iPadOS but **not** iPhone.
- Safari 17.2 (Dec 2023) shipped it on iPhone flag-gated and buggy, then Safari
  **17.4 disabled it again** — release notes: *"Fixed multiple issues by
  disabling support for the Fullscreen API on iOS."* Still off as of 2026.
- Only `<video>.webkitEnterFullscreen()` works on iPhone — useless for a
  full-page app shell.

So on iPhone `document.documentElement.requestFullscreen` is `undefined`.

## Decision

Treat element fullscreen as an optional capability, gated on a single helper
`isFullscreenSupported()` (`src/mainview/fullscreen.ts`):
`typeof document.documentElement.requestFullscreen === "function"`.

- The first-tap auto-engage listener is not installed when unsupported.
- The Fullscreen menu row in `GlobalHeader.tsx` is hidden when unsupported —
  no dead control on iPhone. Android and desktop browsers keep it.

Do NOT re-attempt fullscreen-on-iPhone without first checking current WebKit
release notes — the platform gap is Apple's, not ours.

## Risks

- iPhone users keep the Safari address/tab bars in remote mode. Accepted:
  platform limitation, nothing dev3 can do short of a PWA.

## Alternatives considered

- **Add to Home Screen (standalone/PWA display mode)** — the only chromeless
  path on iPhone. Rejected for the same reason 133 rejected a PWA: the serving
  origin (tunnel hostname / LAN port) is unstable per launch, so an installed
  bookmark rots immediately. Revisit only if remote gets a stable named origin.
- **`webkit`-prefixed `requestFullscreen` fallback** — does not exist on iPhone
  for non-video elements; nothing to fall back to.
