# Which meaning of "remote is active" gates the update countdown

## Context

The update-ready toast in `GlobalHeader.tsx` runs a 5-minute countdown and then
restarts the app by itself. While remote access is on, the person that restart cuts
off is the one holding a phone or a browser tab — the one who cannot see the timer.
The countdown must not run at all in that state.

## Investigation

"Remote is active" is not one state in this codebase:

| State | Where | Why it is or is not the gate |
|---|---|---|
| LAN server listening | `startRemoteAccessServer` runs unconditionally at boot (`src/bun/index.ts`) | Permanently true — gating on it would kill the countdown forever |
| Tunnel `starting` / `connected` | `getTunnelState()`, `cloudflare-tunnel.ts` | Deliberate: on the desktop the main tunnel starts only from the Remote Access modal, never at boot |
| Browser clients attached | `rpcClients.size`, `getConnectedClientCount()` | Somebody is literally driving the app right now |
| Tunnel `failed` / `idle` | same | Not remote — nothing is reachable |
| `isHeadless()` — this process *is* `dev3 remote` | `getUpdateRestartContext` | Already gated separately, and stays gated |

## Decision

Gate on `isRemoteAccessActive()` (`src/bun/remote-access-server.ts`), extended to
count a tunnel in `starting` as well as `connected`, so the predicate matches the
"remote on" state the header already paints. `getUpdateRestartContext` returns it as
`remoteActive`; `GlobalHeader` creates the countdown interval only while it is false,
re-reads it every 5s while the toast is up, and shows `update.remoteNoAutoRestart`
plus the plain "Restart to Update" button when it is true. Remote coming on mid-
countdown stops the timer; remote going away starts a fresh five minutes, because the
machine was only just handed back.

## Risks

- A tunnel stuck in `starting` suppresses the countdown indefinitely. Acceptable: the
  manual restart is always there, and the alternative is restarting under a user.
- The 5s poll adds one cheap local RPC per 5s, and only while an update toast is on
  screen.
- Unknown context (RPC failed) still lets the countdown run visibly, exactly as today;
  the auto-restart itself stays fail-closed on `headless === false`.

## Alternatives considered

- **Connected clients only** — a user who turned the tunnel on and put the phone down
  would still get restarted out from under them.
- **Tunnel only** — misses a LAN browser on a box with no cloudflared.
- **A settings flag "remote enabled"** — no such flag exists; remote is a live state,
  not a preference.
- **Pause and resume the countdown** — rejected: a resumed 12 seconds is worse than a
  fresh five minutes, and Arseny asked for the timer not to start.
