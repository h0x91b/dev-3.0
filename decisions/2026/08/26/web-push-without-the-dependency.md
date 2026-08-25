# Web Push hand-rolled on WebCrypto, and gated on an origin that does not move

## Context

Notifications only reach a phone that already has the app open. Web Push fixes that,
and it fits "no servers to maintain" better than it looks: VAPID (RFC 8292) needs no
account with Apple or Google, no Firebase project and no bill — the application server
is the user's own install. What it does need is a valid certificate and an origin that
survives a restart.

## Investigation

The npm `web-push` package pulls 17 transitive packages to do what `crypto.subtle`
already does, and `src/bun/jwt.ts` already hand-rolls this project's session JWT rather
than take a dependency for it. The whole of RFC 8291 maps onto WebCrypto: ECDH P-256,
two HKDF stages (each one `deriveBits` call, since WebCrypto does extract+expand
together), AES-128-GCM. Validated against both live services from a prototype before any
of it was written here — and a 201 turned out to prove only the JWT, because the push
service cannot decrypt the payload it relays.

Two behaviours would have shipped broken. Apple rejects a VAPID `sub` that is not a
routable address with `403 BadJwtToken` where Google accepts anything, so a
`mailto:…@localhost` passes every desktop-Chrome test and fails on every iPhone. And an
iOS Safari *tab* has no `Notification` API at all, so a user taps Enable, nothing
happens, and the feature looks broken rather than unavailable.

## Decision

`src/bun/web-push.ts` implements VAPID and aes128gcm on WebCrypto, no dependency, with
the keypair generated once into `$DEV3_HOME/web-push-keys.json` at 0600 — rotating it
orphans every device. `src/bun/web-push-store.ts` keeps registered devices, keyed by
endpoint so a re-subscribe replaces rather than double-buzzes, pruned on 404/410.
Registration is gated exactly like `/rpc`: origin checked, then session
(`src/bun/remote-access-server.ts`), because a subscription is a standing capability to
wake someone's phone. `VAPID_SUBJECT` is an https URI naming the software, never a
user's address — it travels to a third party. Delivery hangs off the same
`outboundNotify` fan-out, so `deliverTaskNotification` keeps one call site.

## Risks

A quick tunnel's hostname is random per `cloudflared` process, so an install made on one
becomes an orphan on the next run: the service worker still lives on the device and
keeps showing notifications for an origin that can no longer load. Nothing fails loudly.
The app therefore documents how to get a stable origin (Tailscale serve, a named
Cloudflare tunnel, or a reverse proxy) rather than pretending a quick tunnel is enough.
Delivery is also best-effort by design, and iOS may reclaim a long-idle service worker.

## Alternatives considered

The `web-push` dependency — rejected on the `jwt.ts` precedent and its transitive
weight. A native companion app with an APNs relay — better UX, but it requires the
vendor to run a push relay and hold user identities, which changes what dev-3.0 is. A
vendor-issued hostname per install (the `plex.direct` pattern) — solves the origin
problem and fails the same test. Detecting origin stability in code and hiding the
feature — deferred: the honest signal is not reliably available, and documenting the
requirement respects the user more than guessing at it.
