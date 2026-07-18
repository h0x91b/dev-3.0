# 146 — iOS: fail loudly when /instance is missing, and add an on-device diagnostics log

## Context

After the exchange-on-scan fix (decision 145), pairing progressed past "Pair" but then
looped forever between "Securing the session…" and "Opening dev3…" against a **release**
desktop, with no error, for minutes. There was no way to see what was happening on-device.

## Investigation

`SessionClient.authenticatePairing` calls `GET /instance` *before* the token exchange. On
any failure it took the generic `scheduleBootRetry()` path — infinite backoff retries with
only a spinner. `/instance` is the iOS-only endpoint added on this branch (T0.4); a desktop
that predates it (the user's installed release build) returns 404, so `fetchInstance` threw
every attempt and pairing never advanced. The FSM cycle (`authenticating → connecting →
retry`) with no persisted server matched the reported oscillation exactly. We were also
debugging blind — no client-side trace of the HTTP calls or FSM transitions.

## Decision

1. **Require `/instance`, but fail loudly.** `authenticatePairing` now wraps `fetchInstance`
   separately; on failure it surfaces a specific, actionable message (via `onError`) and
   `expire(.invalidServerResponse)` instead of retrying forever. A 404 says the desktop is
   too old and to update it; other statuses/network errors get their own copy
   (`SessionClientMessages.swift`). A network failure during the exchange itself is handled
   the same way. Making `/instance` *optional* (synthesizing an identity) was explicitly
   descoped by the user — requiring it is fine as long as the failure is visible.
2. **On-device diagnostics.** New `DiagnosticsLog` (thread-safe, bounded ring buffer) records
   a redacted trace — FSM state transitions, expirations, and HTTP method/path/status — with
   **no tokens or cookies**. `SessionHTTPClient` and `SessionClient` write to it. A
   `DiagnosticsView` (Dev3UI) shows it and exports via `ShareLink` (iOS share sheet → Mail,
   etc.). Reachable from the **pairing screen** (so pre-connection failures are inspectable)
   and from Settings. The log never leaves the device unless the user shares it.

## Risks

- Pairing now hard-requires `/instance`; a desktop without it cannot pair (by design), but the
  user is told exactly why. Once this branch ships to the desktop, all servers will have it.
- The diagnostics log is a global singleton (`DiagnosticsLog.shared`); tests that assert on it
  must clear it. Redaction is by construction — callers must never pass secrets.

## Alternatives considered

- **Make `/instance` optional / synthesize identity** — more robust against old desktops, but
  the exchange/rpc endpoints may also differ on old builds, so it risks moving the failure
  downstream; descoped by the user.
- **Bound the retry count instead of stopping** — still leaves the user waiting with no reason;
  a clear immediate error is better for a fresh pairing.
