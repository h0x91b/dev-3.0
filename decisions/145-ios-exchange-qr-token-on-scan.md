# 145 — iOS: exchange the QR token on scan, and surface pairing failures

## Context

Users reported that native iOS pairing silently failed: after scanning the desktop
Remote Access QR code, the "Name this instance" sheet appeared pre-filled with the
expected host, but tapping **Pair** did nothing — the sheet stayed open with no
error, on both Cloudflare and LAN (`192.168.1.x`) origins.

## Investigation

QR tokens are single-use and live only 30s (`QR_TOKEN_TTL_S` in `src/bun/jwt.ts`).
The pairing flow (`PairingViews.NameServerView`) called `controller.pair(...)` — which
runs `POST /auth/exchange` — only when the user tapped **Pair**, i.e. *after* an
open-ended naming step. By then the one-time token was routinely expired (or, after a
retry, already consumed), so the server returned 401. `SessionClient` correctly moved
to `.expired` (`ConnectionControllerTests`/`SessionClientTests` already proved this),
but `ConnectionController` surfaced no error for `.exchangeAndRefreshRejected`, and both
pairing sheets dismissed only on `.connected`. Net effect: a silent stuck screen.
QA had missed it because pairing was only ever validated with a **static dev code**
(`--static-code`), which never expires and skips `exchangeQrForSession`; the real
QR-JWT path was never exercised end-to-end. A fresh QR token exchanges fine and rejects
on replay — confirmed directly against the real `jwt` module.

## Decision

1. **Exchange on scan, not after naming.** `PairingViews.handleScannedValue` now calls
   the new testable `PairingScan.begin(scannedValue:using:)`, which parses the value and
   immediately calls `controller.pair(credential, displayName: host)`. The blocking
   *Name this instance* sheet (`NameServerView`) and its `pendingPairing` state are
   removed — you cannot gate a single-use 30s token behind open-ended UI. The instance
   is saved under the scanned host name (consistent with the already-optional name in
   manual entry) and can be reconnected/removed from Settings.
2. **Surface pairing rejections.** `ConnectionController.bind` now sets
   `errorMessage = ConnectionController.pairingRejectedMessage` when a session expires
   with `.exchangeAndRefreshRejected` (a failed *fresh* pairing). Saved-session
   expirations (`.noSavedSession`, `.refreshRejected`, …) stay quiet — they route to the
   pairing screen, not an error. `ManualPairingView` also shows this on `.expired`
   instead of leaving its sheet silently open.

## Risks

- Removing the pre-connect naming step drops the ability to rename during pairing. The
  saved instance keeps the host name; a post-pairing rename affordance in Settings is a
  reasonable fast-follow. This is an inherent consequence of the token's lifetime, not a
  regression relative to a working flow.

## Alternatives considered

- **Increase `QR_TOKEN_TTL_S`** — weakens the URL-is-the-password security window and is
  a backend change affecting browsers too; does not fix the "no feedback on failure" bug.
- **Exchange on scan but keep a post-connect naming sheet** — the sheet auto-dismisses on
  `.connected` (arrives in ~1s), so a pre-dismiss naming step is incoherent; deferred to
  a Settings rename instead.
