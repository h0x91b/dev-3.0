# Remote connection quality: what the number is, and why the tunnel looked innocent

## Context

Remote mode over the Cloudflare tunnel felt laggy and nothing in the app could
say whose fault it was. Seq 1468 measured ICMP from the host (LAN gateway
2.34 ms, `trycloudflare.com` 4.67 ms, `1.1.1.1` 5.19 ms) and concluded the tunnel
imposes roughly a 5 ms floor; Seq 1470 found ~32 ms of our own fixed lag in the
PTY pipeline and fixed two blockers. There was no measurement of the tunnel on
the path that actually carries a click — an app-level round trip through the
`/rpc` WebSocket.

## Investigation

Measured on 2026-08-20 from this host, headless Chromium on the same machine,
25 serialized round trips per side, box load 8.2–8.7:

| Path | p50 round trip | Server-side share | Jitter |
|---|---|---|---|
| `localhost` (no tunnel) | 0.2 ms | 0 ms | 0.3 ms |
| Cloudflare quick tunnel | 331.7 ms | 0 ms | 15.3 ms |

The tight distribution around 330 ms looked like a fixed delay rather than
distance, so the first hypothesis was that something in `cloudflared` or our
server was holding the frame. That was **disproven**: the tunnel's assigned edge
was `dub03` (Dublin, `cf-ray: …-DUB`), ICMP to the assigned tunnel host averaged
163.8 ms, TCP connect through it 165 ms, and 4 × 82 ms one-way crossings account
for 331 ms almost exactly — the browser and `cloudflared` share this host, so
each direction crosses the ocean twice.

The second hypothesis, "the quick tunnel picked a far colo", was **also
disproven**: `1.1.1.1` and the `trycloudflare.com` apex both answered in ~164 ms
too. The default route runs over `utun4` (a VPN) and the first hop past the
0.13 ms LAN gateway already costs 164.9 ms. Seq 1468's 5 ms figures were taken on
a different network state, and comparing them to a tunnel reading is what made
Cloudflare look like the culprit.

**Verdict on the original question: neither the tunnel nor our pipeline. Our
share of a remote round trip measured 0 ms; the network's share was the whole
331 ms, and 164 ms of that is this machine's own egress before Cloudflare is
reached at all.**

## Decision

The definition lives in `src/shared/connection-quality.ts`, in code rather than
prose, because the widget is only as honest as its definition:

- **One sample is a `ping` RPC round trip through the same `/rpc` WebSocket every
  other request uses** — renderer stamp to renderer stamp. Deliberately not ICMP
  or TCP to the edge (different path, always flatters) and deliberately not the
  `/pty` socket, which `mainview/terminal-latency.ts` already samples and which
  additionally carries tmux and the shell.
- **The us-versus-network split comes from `serverMs`**, stamped in
  `remote-access-server.ts` between reading the frame and writing the answer.
  Both stamps are on the host's clock, so browser/host skew cannot corrupt it.
  What it cannot divide further is browser↔edge from edge↔`cloudflared`; neither
  hop reports itself to us, so the popover says so and points at the direct-LAN
  URL as the comparison that isolates the tunnel.
- **The headline is the median, jitter is mean absolute deviation from it, and a
  stalled request is a loss, never a large sample.** Averaging a timeout in would
  drag the median toward a value no round trip ever had.
- **Sampling is every 5 s while visible, paused when hidden.** ~135 bytes per
  sample, under a thousandth of the terminal stream on the same link. A hidden
  tab's throttled timers would measure the browser, not the link.
- **Placement: the header slot the QR icon occupies, and only in remote mode.**
  Seen from the far end that icon offers a code for the connection already in
  use. A swap, never a second control — see the UX note in the risks below.

## Risks

- In remote mode the header now carries two ambient readouts (memory headroom and
  this), against the manifest's `ambient_resource_readout: budget 1`. Accepted as
  a remote-only exception because the total number of header controls is
  unchanged; if the budget is enforced, this is the one to fold into the kebab.
- `serverMs` on the response envelope is additive and unversioned. Safe here
  because the remote server serves the bundle that reads it — both ends always
  ship together. It is not a promise to any other consumer.
- The 0 ms server share is honest but flattering to us on `ping`, which is the
  cheapest handler there is. It bounds our transport cost, not the cost of a real
  request; a slow `getTasks` is a different measurement.
- The VPN finding is a snapshot of one afternoon. Nothing in the app knows about
  `utun4`, and the widget will keep attributing its cost to "the network", which
  is where it belongs but is not where a reader would look first.

## Alternatives considered

- **A new ping/pong frame on the terminal WebSocket.** Rejected: `ping` on `/rpc`
  already exists (the desktop bridge watchdog uses it) and needs no new message
  type at all. Note that `decisions/2026/07/22/native-session-protocol-v1.md`
  freezes the *local native-session registry* protocol, not `/rpc` or `/pty`, so
  the frozen-protocol constraint never applied to this path.
- **Piggybacking on the 2-second renderer heartbeat.** Would have cost zero extra
  traffic, but its handler does real work, so its round trip mixes link cost with
  watchdog bookkeeping — the opposite of what this measures.
- **Extending `ConnectionStatusPill` instead of adding a header readout.** The
  manifest's diagnostics surface is "earned, not permanent", so a good link would
  show nothing — which fails the whole point of being able to look and see a
  number.
- **A permanent segment-by-segment breakdown (browser→edge→cloudflared→us).**
  Out of reach: Cloudflare exposes the edge colo on `cf-ray` for HTTP responses
  but nothing per-WebSocket-message, and `cloudflared`'s metrics report no
  per-hop latency on http2. Comparing tunnel against direct-LAN is the honest
  substitute, and the popover asks for it explicitly.
