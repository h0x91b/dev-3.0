# 133 — Remote session auth via HttpOnly cookie + persisted JWT secret

**Supersedes [086](086-remote-session-persistence.md).**

## Context

Remote mode from a phone was fragile to the point of unusable: any desktop app
restart silently invalidated ALL sessions (the JWT secret was random
per-process), and the client could not tell "network down" from "session dead"
(a failed WebSocket upgrade closes with code 1006 either way), so a dead token
spun an infinite "Reconnecting…" loop. The session token also lived in
localStorage and rode WebSocket query strings, leaking into proxy/cloudflared
logs and staying readable to any injected script.

## Investigation

Decision 086 rejected an HttpOnly cookie claiming "cookies don't ride
WebSocket query-param auth". That reasoning was factually wrong: **browsers DO
send same-origin cookies on the WebSocket upgrade request.** The constraint
that makes `SameSite=Strict` viable here: static assets are served
unauthenticated (`remote-access-server.ts` gates only `/rpc`, `/pty`, `/p/`,
`/auth/*`, `/health`), so the HTML shell needs no cookie and every
JS-initiated same-origin fetch/WS upgrade carries it.

## Decision

1. **Full switch to cookie auth, no dual path** (`src/bun/remote-access-server.ts`):
   `POST /auth/exchange` answers with an HttpOnly, `SameSite=Strict`,
   `Path=/` session cookie (`dev3_session`); `/auth/refresh`, the `/rpc` and
   `/pty` WebSocket upgrades, and `/health` authenticate via that cookie.
   The localStorage token and token-in-query WS auth are removed entirely —
   safe because the remote client JS is always served by the same server that
   validates it (no version skew).
2. **Origin-header check** (`checkOrigin`) on WS upgrades (cross-site
   WebSocket hijacking) and auth POSTs (CSRF). Missing Origin (non-browser
   client) is allowed — cookie theft via a hostile page requires a browser,
   which always sends it.
3. **JWT secret persisted** to `~/.dev3.0/remote-jwt-secret` (0600, created
   once; `src/bun/jwt.ts` `initSecret`) so sessions survive app restarts. A
   NEW additive file — data-layout invariants hold; no rotation mechanics.
4. **Session TTL 8h → 24h**, still rolling (refresh on load + every 15 min).
5. **Client reconnect state machine** (`src/mainview/remote-session.ts`): on
   WS close it probes `/auth/refresh` — 401/403 terminates the loop and shows
   the scan-QR screen; a network failure continues exponential backoff (2s
   doubling, 15s cap). A consumed QR reopened from history falls back to the
   cookie probe and re-enters silently.

## Risks

- No `Secure` flag: LAN mode is plain http — accepted, same threat model as
  the URL-is-the-password QR link (086's reasoning, unchanged).
- A leaked cookie is valid up to 24h and rolls while used. Accepted: remote
  access targets the user's own trusted devices, is gated by a 30s single-use
  QR, and the cookie is now XSS-unreadable and absent from logs — strictly
  better than the localStorage token it replaces.
- The persisted secret file makes the dev3 home directory security-sensitive;
  0600 and no rotation is the deliberate simplicity trade-off.

## Alternatives considered

- **Keep localStorage + query-param auth** (086): rejected — leaks into
  tunnel/proxy logs, readable by injected script, and 086's cookie rejection
  was based on an incorrect claim.
- **Separate long-lived device/refresh token pair**: textbook, but adds a
  second token type, storage, and revocation surface. Deferred again.
- **PWA to escape browser chrome/back-button issues**: rejected — the serving
  origin (tunnel hostname / LAN port) is unstable per launch; an installed
  PWA would rot immediately.
