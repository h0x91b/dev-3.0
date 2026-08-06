# 021 — QR Token Exposure in URL

## Context

Remote access uses JWT tokens embedded in QR code URLs (`?token=...`). The browser receives this token to bootstrap authentication via `/auth/exchange`.

## Decision

We accept that the QR token is briefly visible in the URL. Mitigations:

1. **Short-lived** — QR token expires in 30 seconds and is one-time use (JTI replay prevention in `src/bun/jwt.ts`).
2. **URL cleanup** — `history.replaceState()` removes the token from the address bar immediately on load (`src/mainview/rpc.ts`, `initBrowserApi`).
3. **Exchange pattern** — the QR token is exchanged for a 30-minute session token that never appears in URLs or logs.

## Risks

Before `replaceState` fires, the token may appear in: server access logs (our server doesn't log query params), browser history (if user refreshes before JS runs), and Referer headers (mitigated: our SPA doesn't navigate to external URLs). All moot because the token expires in 30s and can only be used once.

## Alternatives considered

- **Cookie-based auth** — would avoid URL exposure entirely but requires same-origin, breaking Cloudflare Tunnel scenarios where the tunnel hostname differs.
- **WebSocket-only auth** — would require a separate handshake flow, adding complexity for marginal gain given the 30s + one-time-use constraints.
