# 097 — Force cloudflared quick tunnels onto the http2 transport

## Context

Remote access via the Cloudflare tunnel (QR code / public link) silently stopped
working: the modal showed a `*.trycloudflare.com` URL and a green "Public tunnel
active" badge, but the URL was `NXDOMAIN` on every resolver (including Cloudflare's
own `1.1.1.1`) and no request ever reached the server (all logged requests were
`ip: direct`, i.e. LAN/local — none carried `cf-connecting-ip`).

## Investigation

Starting a fresh quick tunnel by hand and reading cloudflared's full stderr showed
the root cause. cloudflared's pre-check reported:

```
UDP Connectivity  region1.v2.argotunnel.com  FAIL  QUIC connection failed
WARNING: Allow outbound QUIC traffic on port 7844 or use HTTP2.
ERR Failed to dial a quic connection error="failed to dial to edge with quic: timeout: no recent network activity"
Retrying connection in up to 2s … 4s … 8s … 1m4s
```

`Registered tunnel connection` count = **0**. Quick tunnels pin `protocol:quic`
(UDP/7844). On any network that blocks outbound UDP/7844 (corporate/VPN/hotel
Wi-Fi — very common), cloudflared prints the assigned URL optimistically ("it may
take some time to be reachable"), then never registers with the edge and retries
QUIC forever without falling back to http2 — so the hostname is never provisioned
in DNS. Re-running with `--protocol http2` (TCP/443, already reachable per the
pre-check's TCP row) registered immediately and the tunnel served end-to-end
(`/` → 200, `/health` → 401 through the public URL).

## Decision

Default the cloudflared transport to **http2** instead of its own `quic` default.
`src/bun/cloudflare-tunnel.ts` now spawns `cloudflared tunnel --protocol <p> --url …`
where `<p>` comes from `resolveTunnelProtocol()` (default `http2`, overridable via
`DEV3_CLOUDFLARED_PROTOCOL=quic|http2|auto`). This is the single spawn choke point,
so it covers the main web-UI tunnel and per-task port/shared tunnels alike.

## Risks

- Marginally higher latency where QUIC would have worked; negligible for our
  WebSocket-based (RPC + PTY) remote UI, which http2 tunnels carry transparently.
- `--protocol auto` was rejected: observed to stick on QUIC and not downgrade for
  quick tunnels, so it would not have fixed the blocked-UDP case.

## Alternatives considered

- **`--protocol auto`** — should fall back to http2 but empirically doesn't for
  quick tunnels on this network; unreliable.
- **Try QUIC, detect non-registration, restart with http2** — adds startup latency
  and complexity for a transport that has no functional benefit here.
- **Named tunnel + Cloudflare account** — stable but requires user credentials and
  breaks the zero-config nature of the feature.

## Follow-up (not in this change)

The tunnel is marked `connected` as soon as the URL is parsed from stderr, before
edge registration — that is why the UI showed a live URL while the tunnel was dead.
Gating `state = "connected"` on a `Registered tunnel connection` line would remove
that false positive; left as a separate change.
