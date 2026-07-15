# 086 — Persist the remote-access session token + 8h TTL

> **Superseded by [132](132-remote-cookie-session-auth.md).** Session auth
> moved to an HttpOnly cookie with a disk-persisted signing secret and a 24h
> rolling TTL. Note: this record's stated reason for rejecting cookies
> ("cookies don't ride WebSocket query-param auth") was incorrect — browsers
> do send same-origin cookies on WebSocket upgrade requests.

## Context

`dev3 remote` authenticates a browser by exchanging a one-time QR token for a
session JWT. The session token was held **in memory only** (`src/mainview/rpc.ts`,
`initBrowserApi`) with a 30-minute TTL. Consequences: reloading the tab, or
picking your phone back up an hour later, wiped the token and forced a fresh QR
scan from the desktop app — painful for the common "drive a remote Linux box
from my phone" flow.

## Decision

1. **Persist the session token in `localStorage`** (`dev3-remote-session`). On
   load, if the URL carries a QR token we exchange it as before; otherwise we
   try to **refresh the stored token** (`POST /auth/refresh`). Success → silent
   reconnect, no QR. A server rejection (expired/invalid) clears the stored
   token and shows the existing "scan a fresh QR" screen.
2. **Bump the session TTL 30 min → 8 h** (`SESSION_TOKEN_TTL_S` in `src/bun/jwt.ts`).
   The token is refreshed on load and every 15 min while open, so an active
   device rolls the window forward indefinitely; a device idle past 8 h expires.

## Risks

- A leaked/stolen session token stays valid longer (up to 8 h, or indefinitely
  if the attacker keeps a tab open and refreshing). Accepted because remote
  access is already a "URL-is-the-password" capability gated by the one-time QR,
  and the feature targets the user's own trusted devices. The QR token itself is
  unchanged (30 s, single-use, replay-protected).
- `localStorage` persists across browser sessions on shared machines. Users on a
  public/shared browser should not use remote access — same caveat as pasting the
  access URL there.
- A server restart rotates the JWT secret, invalidating stored tokens; the next
  load refreshes → 401 → cleared → rescan. Expected.

## Alternatives considered

- **Keep 30 min, persist only.** Fixes tab reload but not "reconnect hours
  later" — the headline ask. Rejected as half a fix.
- **Separate long-lived refresh/device token.** A 30-day device token exchanged
  for short session tokens is the textbook design, but adds a second token type,
  storage, and revocation surface. Deferred — the single-token + longer-TTL
  approach delivers the UX at a fraction of the complexity.
- **httpOnly cookie instead of localStorage.** Cookies don't ride WebSocket
  query-param auth (the existing transport) and need CSRF handling; localStorage
  matches how the token is already threaded into `?token=`.
