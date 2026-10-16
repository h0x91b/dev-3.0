# Tunnel recovery waits for the old process and retries until the tunnel is back

## Context

A headless box with a custom tunnel command served Cloudflare error 1033 for hours after a short network outage. The public-URL probe failed three times, the health monitor restarted the tunnel, and the restart failed once; nothing tried again. A connector that exits on its own was never restarted at all — its exit handler only marked the entry idle.

## Investigation

`restartEntry` sent SIGTERM and spawned the successor in the same tick. cloudflared's graceful shutdown lasts up to 30 s (`--grace-period`), and the user's wrapper holds an exclusive lock for the connector's lifetime so two connectors never serve one hostname, so the successor exited 1 ("already has a connector running") and `Tunnel restart failed` was terminal. A first fix kept retry state beside the tunnel map; review found that every caller that reads the map (task cleanup, `stopAll`, the Remote Access modal's "idle → auto-start") then missed a tunnel between attempts or mid-restart.

## Decision

In `src/bun/cloudflare-tunnel.ts` a lost tunnel keeps its slot: `beginRecovery` puts a placeholder entry (state `starting`, no process, `placeholder: true`) carrying a `TunnelRecovery` into the map, so list, stop, `stopAll`, port-tunnel cleanup and the UI see a tunnel that is coming back, and an explicit `startEntry` joins or hurries the recovery instead of racing it. `restartEntry` tears down, then the first attempt awaits `waitForPredecessor` (the process, a pipeline's children, an adopted PID; SIGKILL after `TUNNEL_RECOVERY.oldProcessExitTimeoutMs`). Failed attempts back off (`retryDelaysMs`, capped at 5 min) without limit — except a blank or not-found custom command, which is never retried for any kind: `startEntry` records `failureReason`, and the recovery releases the slot so the next explicit start reports it. An entry a recovery started keeps the recovery until a passing health check proves it, so best-effort "connected" starts do not reset the backoff. Only `stopEntry` ends recovery — every await re-checks that the slot still holds its placeholder or attempt — and `releaseFailedStart` only ever releases its own entry. Cloudflare's 530 (tunnel down) no longer counts as a healthy probe. A headless start that failed, and a self-update abandoned after stopping a wanted tunnel (`prepareHandoff` → `clearHandoff` in `self-update.ts`), resume via `retryMainTunnel` (false for a misconfigured command). The Remote Access toggle can now stop a tunnel that is `starting`.

## Risks

A recovered Quick Tunnel gets a new hostname; it propagates through the existing change hook, as watchdog restarts already did. Retrying forever means a permanently broken network logs a retry every 5 minutes; conversely a wrapper whose own dependency is missing exits 127 and reads as a not-found command, which is not retried. A placeholder reads as `starting` for up to one backoff interval, which the modal shows as "starting". SIGKILL skips cloudflared's graceful drain, which only matters for requests in flight on a tunnel being replaced as unhealthy.

## Alternatives considered

A retry map beside the tunnel map was tried first and rejected for the reason above. Retrying a fixed number of times was rejected: outages outlast any small count, and the box has no other way back. Waiting the full 30 s grace period was rejected because it doubles the outage for a tunnel already declared unhealthy. A new `reconnecting` tunnel state was rejected for now: `starting` already means "not serving yet, coming up" everywhere the state is read. Restarting the whole app from a supervisor works, but drops every browser session to recover one child process.
