# 106 — Compiled ObjC shim for notification click callbacks

## Context

Clicking a macOS notification should focus the task that fired it. Electrobun's
`Utils.showNotification` is fire-and-forget (no click callback, no userInfo —
upstream issue blackboardsh/electrobun#384 is the maintainer's own spec for
this, still open; PR #307 was closed in its favor). Our workaround was a
focus-proxy: treat "app became foreground within 3s of a notification" as a
click (`consumeRecentWatchedNotification` in `rpc-handlers/shared.ts`). Clicks
later than 3s, or clicks the OS delivered through other activation paths, were
lost.

## Investigation

A pure bun:ffi + libobjc delegate (no compiled code) is **not viable**:
Electrobun runs `startEventLoop` on the process main thread and the app's Bun
JS in a Worker, so native→JS calls must use `JSCallback({threadsafe: true})`,
which is fire-and-forget — the JS body runs later on the Bun thread. A
`UNUserNotificationCenterDelegate` must call its completion handler
synchronously and read the autoreleased `UNNotificationResponse` before it
dies; both are impossible from a deferred JS callback.

## Decision

Ship a ~130-line compiled shim, `src/native/macos/dev3-notifications.m` →
`dist/native/dev3-notifications.dylib` (built by
`scripts/build-native-notifications.sh` inside `build:cli`, bundled via the
`"dist/native": "native"` copy rule). It sets a UN delegate, posts
notifications whose **request identifier encodes `taskId|projectId`** (no
userInfo plumbing; stable per task, so newer notifications replace older ones),
and forwards clicked identifiers to Bun as heap-copied C strings freed by the
JS side. `src/bun/native-notifications.ts` wraps it; `deliverTaskNotification`
in `rpc-handlers/shared.ts` prefers it and only arms the legacy focus-proxy
when the shim declines. Clicks with no window open park the target in
`notification-nav.ts`; the reopened renderer pulls it on mount
(`consumePendingNotificationNav`, same pattern as `consumePendingQuitDialog`).

## Risks

- Setting the UN delegate would conflict with any future Electrobun-set
  delegate (none today); when upstream #384 ships, delete the shim and switch
  to `notification-clicked` events.
- Clicks that *launch* the app (notification clicked after quit) can be missed:
  the delegate is installed after `didFinishLaunching`. Same loss as before.
- Auth state starts unknown; until the request completes, posts fall back to
  the legacy path (which self-requests permission) — first-launch notifications
  behave exactly as before.
- Ad-hoc-signed local dylib could attract EDR (CrowdStrike) attention like the
  electrobun launcher did; `ELECTROBUN_DEVELOPER_ID` signs it properly on
  release builds.

## Alternatives considered

- **Pure bun:ffi objc delegate** — dead on threading, see Investigation.
- **Fork Electrobun's native wrapper** — requires their zig build chain, and a
  vendored 2 MB patched dylib to carry across upstream's in-flight zig-core
  refactor; the shim is additive and survives Electrobun bumps untouched.
- **alerter-style helper .app** — notifications would carry the helper's
  identity in Notification Center, and it needs its own signed bundle.
- **Tuning the focus-proxy TTL** — still a guess; cannot know *which*
  notification was clicked.
