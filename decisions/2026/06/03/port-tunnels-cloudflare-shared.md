# 059: Cloudflare port tunnels — quick + shared modes

## Context

`dev3 remote` already starts a Cloudflare quick tunnel for the headless web UI itself. But the *dev servers* inside a task's worktree (Vite on 5173, backend on 3001, etc.) are still trapped on `localhost`. On a remote Linux box this forces the user to set up `ssh -L` plumbing for every port they want to reach. We need a one-click way to expose any detected dev-server port — and a way to share a *group* of ports under a single origin so frontend+backend can talk to each other via relative URLs (no CORS).

## Investigation

Considered four approaches for cross-port communication:

1. **Per-port tunnels only** — simplest, but two random `*.trycloudflare.com` URLs can't share state without hardcoded env vars / CORS configuration.
2. **Shared tunnel with path proxy** (`/p/<port>/...`) — one tunnel, multiple ports under one origin. Requires WebSocket-aware reverse proxy in the headless server.
3. **Wildcard subdomain via owned domain** — clean (`api.x.dev`, `web.x.dev`), but requires a paid Cloudflare Zero Trust setup. Outside the "zero config" promise.
4. **SSH `-L` only** — status quo. Works but mismatch with the "browser-first" UX we already built around `dev3 remote`.

Picked 1 + 2 in tandem: quick is the default; shared is opt-in when you have multiple ports.

For auth on shared-tunnel routes we considered JWT (existing session token), HMAC subtoken in path, and cookie-based session. Picked **HMAC-grade random subtoken in URL path** (the "capability URL" pattern, like Google Docs share links): `/p/<subtoken>/<port>/<rest>`. The subtoken is minted at tunnel start, never leaves the URL, and gates both HTTP and WebSocket upgrades uniformly. Cookie-based would have required modifying the dev-server's HTML/JS — a non-starter.

## Decision

- **Tunnel manager**: refactored `src/bun/cloudflare-tunnel.ts` from singleton to `Map<string, TunnelEntry>` keyed by stable IDs (`"main"`, `"task:<taskId>:port:<n>"`, `"task:<taskId>:shared"`). Back-compat shims keep the existing `startTunnel` / `getTunnelUrl` callers working.
- **Orchestration** in `src/bun/port-tunnels.ts`: `exposeTaskPort`, `exposeTaskPortsShared`, liveness-driven auto-stop (2 consecutive port-scan misses), task-scoped cleanup, push-message broadcasting (`exposedPortsChanged`).
- **Shared-tunnel reverse proxy** in `src/bun/remote-access-server.ts`: routes `/p/<subtoken>/<port>/<rest>` to `http://localhost:<port>/<rest>` for HTTP, and upgrades WebSockets to `ws://localhost:<port>/<rest>` for HMR/live-reload. Hop-by-hop headers stripped both directions.
- **RPC**: new `exposePort`, `exposePortsShared`, `unexposePort`, `unexposeShared`, `listExposedPorts`, `getSshForwardCommand` methods in `src/bun/rpc-handlers/port-tunnels.ts`. Push event `exposedPortsChanged` for live updates.
- **CLI**: `dev3 remote --expose-ports=3000,5173` for headless startup; retries every 2 s for 60 s until the port appears in `lsof` output. Uses synthetic taskId `__headless__` to skip liveness auto-stop.
- **Banner**: prints per-port URL list (Public / LAN / Localhost / SSH command), reprinted on every change.

## Risks

- **Public URL = anyone with the link**. trycloudflare.com tunnels are unauthenticated by default; we rely on URL secrecy (256-bit random subtoken for shared tunnels, opaque random hostname for quick). UI shows a warning. Not suitable for production; documented as dev-time.
- **Shared mode requires `base:` config in Vite/Next/CRA**. A bare Vite project served under `/p/abc/5173/` will 404 on its absolute asset paths (`<script src="/assets/...">`). Users must set `base: "/p/<token>/<port>/"` — but the token is random per tunnel start, so this is awkward. Mitigation: Quick mode (default) doesn't have this issue; shared is for advanced cases.
- **cloudflared process count**. Each Expose click spawns a fresh `cloudflared`. ~30 MB RAM each; trycloudflare quotas not publicly documented but observed-fine for 5-10 concurrent. Auto-stop on liveness loss prevents zombies.
- **No persistence**. Tunnels die on app restart by design (state is runtime-only). User has to re-Expose. Trade-off for simpler state management.

## Alternatives considered

- **Reverse-proxy via JWT cookies** instead of capability URLs — required intercepting Set-Cookie on the dev server's responses to rewrite domain/path. Brittle.
- **Subdomain per port** via cloudflare named tunnels — required owned domain + Zero Trust account. Doesn't fit "zero config" promise.
- **Multi-target one cloudflared** — cloudflared supports per-hostname ingress rules in config, but only with named tunnels (not quick). Same blocker.

## Code paths

- `src/bun/cloudflare-tunnel.ts` — `tunnelManager`, `startTunnel` back-compat
- `src/bun/port-tunnels.ts` — `exposeTaskPort`, `exposeTaskPortsShared`, `onTaskPortScanUpdate`, `cleanupTaskTunnels`, `cleanupAllTunnels`
- `src/bun/remote-access-server.ts:parseSharedProxyPath`, `proxyHttpToLocalhost`, `proxyToSharedUpstream`
- `src/bun/rpc-handlers/port-tunnels.ts` — RPC surface incl. `getSshForwardCommand`
- `src/bun/headless-entry.ts` — `--expose-ports` retry loop, push hook wiring, shutdown cleanup
- `src/bun/index.ts` — GUI push hook wiring, window-close cleanup
- `src/bun/remote-console.ts:printExposedPortsBlock`, `printExposedPortsLive`
- `src/cli/commands/remote.ts` — `--expose-ports` flag parsing
