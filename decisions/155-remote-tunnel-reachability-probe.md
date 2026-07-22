# 155 — `dev3 remote` waits for tunnel reachability, not just announcement

## Context

`dev3 remote` starts a Cloudflare quick tunnel (`*.trycloudflare.com`) at boot and prints the public URL + QR. The first version (decision-less, added with the Linux install polish) waited until `cloudflared` *reported* a hostname, then applied a fixed 4s settle. In practice the hostname is announced 2-10s before Cloudflare's edge actually routes it. A user who clicked the link during that window got `DNS_PROBE_FINISHED_NXDOMAIN` — the browser resolved the name too early, cached the negative answer, and then hung long after the record went live.

## Investigation

For a fresh quick-tunnel hostname there are two independent gates before a browser can load it: the DNS record must exist, and the tunnel must be registered at the edge. Until the tunnel registers, Cloudflare's edge returns HTTP **520-530** (530 / error 1033 "Argo Tunnel error"); once our origin is reachable through the tunnel, any real status (200/301/401/404) comes back. A thrown `fetch` (ENOTFOUND / connection refused / TLS not ready) means DNS/connect isn't ready yet. An end-to-end HTTP request is therefore a strict superset of a DNS check — it can only succeed once *both* gates pass.

## Decision

`awaitTunnelReady` (`src/cli/commands/remote.ts`) is now two phases: (1) poll the CLI socket until `cloudflared` reports the hostname; (2) actively `isTunnelLive(url)` — a HEAD `fetch` with `redirect: manual` — every `probeIntervalMs` until it returns a status outside 520-530, printing progress dots. Only then do we print the link (plus a 1s settle). `REMOTE_TUNNEL_WAIT` gained `probeIntervalMs`/`probeTimeoutMs`. Also removed a duplicated `awaitTunnelReady` call in `startDetached` left over from a concurrent-edit race. `isTunnelLive`/the probe are injectable so unit tests need no network.

## Risks

- The 520-530 range is reverse-engineered Cloudflare behavior; if they change edge error codes we might treat "not ready" as ready. Mitigation: a too-early print is no worse than the old behavior, and phase 2 has a bounded `probeTimeoutMs` fallback that prints the link anyway with a caveat.
- The server-side probe confirms the edge is live globally (Cloudflare authoritative DNS), not the caller's exact resolver — but since we don't reveal the clickable link until then, a fresh client resolve won't have cached a negative answer.

## Alternatives considered

- Fixed longer settle (10s) + dots — wastes time on the common 2-3s case and still guesses; the rare 10s+ case still breaks.
- `dns.resolve` polling — matches the NXDOMAIN symptom but the server resolver can itself cache the negative answer, and DNS-OK doesn't prove the edge routes yet. The HTTP probe subsumes it.
