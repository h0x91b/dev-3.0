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
- **A window where nothing answered still renders, as a dash.** The widget hides
  only while nothing has been *attempted*; `count === 0` with losses is the worst
  news it has, and an earlier version hid exactly there. The panel then says
  nothing answered instead of printing the zeros that stand in for measurements
  which never happened.
- **The route label never names Cloudflare on a guess.** Only a
  `trycloudflare.com` / `cfargotunnel.com` suffix is called a tunnel; a bare LAN
  name or a Tailscale host reads "route unknown". Accusing a specific carrier for
  a hostname we cannot classify is the one error this widget must not make.
- **Sampling is every 5 s while visible, paused when hidden.** ~135 bytes per
  sample, under a thousandth of the terminal stream on the same link. A hidden
  tab's throttled timers would measure the browser, not the link.
- **Placement: the header's overflow menu by default; the QR icon's slot only
  while the link misbehaves.** Remote mode only — seen from the far end that icon
  offers a code for the connection already in use, so the swap costs no control.
  A healthy connection is not news and buys no permanent header pixels: the bar
  renders only once the verdict stops being `good` (median past
  `RTT_DEGRADED_MS` = 150 ms, or jitter/loss bad enough to feel), exactly the
  earned-visibility rule `MemoryHeadroomIndicator` uses for OS memory pressure.
  The number is still always readable as the `Connection` row in the kebab, whose
  hover flyout is the same breakdown panel. On narrow both fold into the header
  sheet, where the row is unconditional — an opened sheet must not be empty.
- **The open/pin/position behaviour is one hook, not a copy.** Matching the memory
  readout's behaviour first meant duplicating ~200 lines of it; that machinery is
  now `hooks/useHeaderFlyout.ts` plus `components/HeaderFlyoutPanel.tsx`, and both
  readouts hold only their own content. `TmuxSessionManager` still carries its own
  copy — a wider migration than this change, deliberately left alone.

## Risks

- Two ambient readouts can share the header at once (memory under pressure plus a
  degraded link), against the manifest's `ambient_resource_readout: budget 1`.
  Both are now conditional on their own bad news, so the common case is zero and
  the collision needs two simultaneous problems — accepted without a manifest
  exception. It does mean the header can gain a control exactly when the machine
  is already struggling.
- A link that is bad only in bursts shows a pill that comes and goes. The 30-sample
  window smooths this, but nothing debounces the appearance itself.
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
- **Extending `ConnectionStatusPill` instead of adding a header readout.** Its
  unhealthy-only visibility is the right instinct and is what the header bar now
  does, but that pill has no home for the number when the link is fine, and
  "look and see a number" was the point. The kebab row is that home; the pill
  would have needed one invented for it.
- **A permanent pill on every remote session.** Shipped first and rejected on
  sight: it spends a header slot to say "fine" on a connection nobody is
  wondering about, which is precisely the toolbar creep the UX bible names as this
  project's top anti-pattern.
- **A permanent segment-by-segment breakdown (browser→edge→cloudflared→us).**
  Out of reach: Cloudflare exposes the edge colo on `cf-ray` for HTTP responses
  but nothing per-WebSocket-message, and `cloudflared`'s metrics report no
  per-hop latency on http2. Comparing tunnel against direct-LAN is the honest
  substitute, and the popover asks for it explicitly.
