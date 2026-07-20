# 151 — iOS notifications are local, delivered over the live connection (no APNs)

## Context
A tester asked why notifications "need a live dev3 connection" and whether we can work around it. The
Notification settings footer said so but not *why*, reading like a limitation rather than a design
choice.

## Investigation
The iOS app registers **no** remote-push capability: `Config/Dev3.entitlements` has no
`aps-environment`, `Info.plist` declares no `UIBackgroundModes`/BGTask ids, and `Dev3AppDelegate` never
calls `registerForRemoteNotifications`. Notifications are **local** `UNNotificationRequest`s with
`trigger: nil` (`NotificationService.deliverReplacing`), synthesized from push events —
`webNotification` / `cliAttention` / `terminalBell` (emitted desktop-side in
`src/bun/rpc-handlers/shared.ts` + `cli-socket-server.ts`) — that arrive over the app's live RPC
WebSocket (`Dev3Kit` `SessionClient`/`WebSocketTransport`). iOS suspends a foreground app shortly after
backgrounding and freezes that socket, so events during suspension are never received and no
notification fires. There is no cloud/relay in between — task titles and messages stay on the link
between the user's own devices.

## Decision
Keep the local-connection design and **reword the footnote** to explain the *why*
(`NativeNotificationPolicy.backgroundDeliveryLimitation`, `NotificationModels.swift`): notifications
come straight from the Mac over a private live connection, no cloud, and iOS pauses them once the app is
fully suspended. Do **not** add APNs now — it is a product decision, not a bug fix.

## Risks
Background-suspended notifications still won't arrive; the reworded copy sets that expectation. Reopening
the app reconnects and re-syncs badge/attention state.

## Alternatives considered
- **APNs (real remote push):** the only mechanism giving true background delivery. Technically feasible
  direct-from-desktop (outbound HTTPS reaches Apple even behind the cloudflared tunnel), but requires an
  Apple push key owned/shipped in every local install, per-device token routing across multi-server
  pairing, and — for a relay variant — routing task content through third-party infra, which breaks the
  local-first, no-cloud property. Deferred as an explicit product decision.
- **BGAppRefreshTask / silent push / audio-keepalive:** cannot hold a live socket; cadence and budget
  make timely delivery impossible and keepalive risks App Store rejection. Rejected.
- **`beginBackgroundTask` grace window:** a small ~30s post-background hold could catch a few
  just-missed events; low value, touches the connection lifecycle, deferred.
