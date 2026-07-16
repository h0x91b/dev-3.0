# Native iOS discovery and session classes

## Context

The native iOS companion must find a local dev3 server without a typed address and remain paired longer than the browser remote UI. Discovery cannot become a startup dependency, and all installed app versions must continue sharing the existing `~/.dev3.0` layout safely.

## Investigation

DNS-SD is the platform-native local discovery mechanism, but shelling out to a Homebrew binary would fail for in-app-updated and non-Homebrew installations. Extending the existing signed session payload is backward-compatible because old browser tokens omit unknown optional claims and already refresh through the same JWT module.

## Decision

Persist an additive UUID at `~/.dev3.0/remote-instance-id`, expose it through unauthenticated `GET /instance`, and advertise `_dev3._tcp` with a pure-JavaScript `bonjour-service` boundary that silently disables itself on unsupported networks or `DEV3_REMOTE_NO_MDNS=1`. Accept `client: "ios"` only when `Origin` is absent, sign that class into a 30-day rolling session, and keep unmarked or browser-origin sessions on the existing 24-hour window.

## Risks

Some managed networks block multicast, so native clients still need manual host entry and `/instance` validation. A native marker is not a new authentication factor; the one-time QR/static code remains the trust boundary, while the signed claim only preserves refresh lifetime.

## Alternatives considered

Network-framework discovery in the iOS app alone cannot advertise a server, and external `dns-sd`/Avahi commands violate dependency guarantees. Giving every session 30 days would unnecessarily widen browser exposure, while a separate refresh-token store would add migration and revocation complexity without improving the current pairing model.
