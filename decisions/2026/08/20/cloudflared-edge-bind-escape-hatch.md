# DEV3_CLOUDFLARED_EDGE_BIND — leaving the VPN, only when asked

## Context

`remote-connection-quality-definition.md` (same day) measured a remote round trip
at 331 ms and traced it to the host's VPN: the default route ran over `utun4`,
whose exit is in Ireland, so Cloudflare assigned a Dublin edge and every frame
crossed the VPN twice per direction. Our own share of that wait measured 0 ms —
there was nothing left to optimise inside the app.

## Investigation

A VPN's "full tunnel" on macOS is route **priority**, not enforcement. Both
default routes coexist:

```
default   192.168.18.87   UGScg     utun4    ← wins the unscoped lookup
default   172.16.32.1     UGScIg    en0      ← alive in its own interface scope
```

A socket bound to `en0`'s address makes the kernel resolve inside that scope and
use the physical gateway. Verified: `route -n get 1.1.1.1` answers `utun4`,
`route -n get -ifscope en0 1.1.1.1` answers `en0`; `cloudflare.com/cdn-cgi/trace`
returns `loc=IE colo=DUB` unbound and `loc=IL colo=TLV` bound to `en0`; ICMP to
`1.1.1.1` is 162.5 ms unbound and 4.7 ms bound — which matches Seq 1468's 5.19 ms
and proves that measurement was taken off-VPN.

Live A/B through this module's own `tunnelManager`, trivial origin, 6 keepalive
HTTP requests per cell, medians, box load 6.2–8.1:

| `DEV3_CLOUDFLARED_EDGE_BIND` | Edge | Client under VPN | Client off VPN (a real phone) |
|---|---|---|---|
| unset | `dub01` | 340 ms | 260 ms |
| `en0` | `tlv02` ×3, `mrs06` ×1 | 261 ms | **24–27 ms** (99 ms on the `mrs06` run) |

Only the host side needs changing: a phone is a separate device and is already
off the corporate VPN.

## Decision

`resolveTunnelEdgeBind()` + `buildTunnelArgv()` in `src/bun/cloudflare-tunnel.ts`,
alongside the existing `resolveTunnelProtocol()`:

- **Unset by default**, and the default is the decision. The win exists only when
  a VPN's exit is far from the machine; with no VPN, or a nearby one, there is
  nothing to gain. And leaving through the physical interface takes that traffic
  out of whatever the VPN was installed to do, which belongs to whoever operates
  the machine — never to us.
- **Accepts an interface name (`en0`) or a literal address.** The name is
  preferred: a DHCP address stops being true after a reconnect, and a stale bind
  address leaves cloudflared unable to dial at all.
- **Anything unresolvable is logged and dropped**, never fatal. A tunnel that
  starts slowly beats one that does not start. Loopback is excluded — it cannot
  reach the edge.
- **`--edge-bind-address` goes last, after `--url`.** Placed earlier, cloudflared
  prints its help and exits the parser without registering; the URL never
  appears, so the failure reads as "the tunnel is slow" rather than "the flag is
  misplaced". `buildTunnelArgv` owns the order and a test asserts it — mutation-
  checked by moving the flag before `--url`, which fails that test.

## Risks

- **It routes part of the user's traffic around their VPN, and that traffic is
  their whole working session** — terminals, repository contents, agent output.
  Mitigated only by being opt-in and off by default; the choice is stated in the
  code comment so nobody enables it thinking it is a pure latency knob.
- **The gain is not stable.** Cloudflare's colo choice for a quick tunnel varied
  across runs on the same interface (`tlv02` three times, `mrs06` once → 25 ms vs
  99 ms). Still a large win either way, but it is not a fixed number and must not
  be quoted as one.
- **Measured on one machine, one afternoon, one VPN.** The mechanism is generic
  macOS scoped routing; the numbers are not portable.
- A VPN enforced with a packet filter, or one that removes the physical default
  route, will make the flag silently useless — cloudflared then fails to dial and
  retries. Nothing detects that for the user beyond the tunnel not coming up.

## Alternatives considered

- **Default it on when a far VPN is detected.** Rejected: it would silently move
  a user's traffic out of a policy boundary that may be mandatory, to buy
  milliseconds.
- **Skip the tunnel entirely when the client shares the LAN.** Rejected on a
  constraint the latency argument never touches: the LAN URL is plain HTTP, and
  the browser features remote mode depends on are gated behind a secure context,
  so connectivity works while a good half of the app stops. The tunnel is not
  only a route, it is where the certificate comes from. Fastest is not usable.
- **A named tunnel with more HA connections, or `--region`.** Neither moves the
  meeting point: the extra connections land near the same egress, and `--region`
  only offers `us` and the default.
- **QUIC.** Forbidden by `decisions/2026/07/02/cloudflared-http2-protocol.md` and
  irrelevant — it changes the transport, not the number of crossings.
