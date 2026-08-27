# Drop the public-IP lookup and `ip_override` from GA4 analytics

## Context

`src/mainview/analytics.ts` resolved the user's public IP from `api.ipify.org`, cached it in
`localStorage` for a day, and attached it to every GA4 Measurement Protocol hit as `ip_override`,
so GA4 would populate the Country/City dimensions. Two things made that untenable: security
scanners flagged dev3 for sending a real IP (correctly — it is deliberate collection of personal
data plus a third-party egress, not the transport-level source address a scanner would ignore),
and `AGENTS.md` limits what may leave the machine to a random per-install id and coarse facts
about the app, which an IP is not.

## Investigation

The geo dimensions never populated in the GA4 reports, so the whole mechanism was paying a
privacy cost for nothing. The MP debug endpoint (`/debug/mp/collect`) returns empty
`validationMessages` both with and without `ip_override`, so it neither confirms nor rejects the
field — it validates nothing here and is not evidence either way. `api.ipify.org` itself answers
HTTP 200, so an unreachable lookup service is not the explanation.

Not established: *why* GA4 ignores the field. The removal does not depend on the answer — the
mechanism is out either way, and geolocation, if it is ever wanted back, belongs on the
`/g/collect` endpoint gtag.js itself uses, where the request's own source IP is geolocated
normally and no lookup service is involved.

## Decision

Removed `resolvePublicIp()`, the `ipOverride` module state, the `dev3-ga-ip` /`dev3-ga-ip-ts`
cache keys, and the `ip_override` field in `sendToGA`'s body. `clearStaleIpCache()` runs at the
top of `initAnalytics` — before the telemetry gate, since erasing a stored value sends nothing —
so installs upgrading from an older version stop carrying a cached IP on disk. Three tests in
`src/mainview/__tests__/analytics.test.ts` ("the user's IP never leaves the machine") cover the
absent lookup, the absent field, and the cache erase; each was verified by re-introducing what it
guards and watching it fail.

## Risks

GA4 Country/City stay `(not set)`. That is the status quo — they were never populated. PostHog
still geolocates its own events from the request IP on its side, which is ordinary vendor
behaviour and unaffected.

## Alternatives considered

- **Truncate the last octet before sending.** Keeps city-level geo and is what GA's old IP
  anonymization did, but it still collects an IP through a third party for a mechanism with no
  evidence of working.
- **Switch to `/g/collect` now.** The endpoint gtag.js posts to, where the source IP geolocates
  natively with no lookup service. Undocumented, and it needs the whole payload rewritten from MP
  JSON to gtag query parameters — a separate change, only worth making once someone confirms the
  geo actually lands.
- **Keep it, document it in SECURITY.md.** Rejected: the scanner finding is accurate, and the
  mechanism was not delivering the data it cost us.
