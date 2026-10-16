# Tunnel recovery waits for the old process and retries until the tunnel is back

## Context

A headless box with a custom tunnel command served Cloudflare error 1033 for hours after a short network outage. The public-URL probe failed three times, the health monitor restarted the tunnel, and the restart failed once; nothing tried again. A connector that exits on its own was never restarted at all — its exit handler only marked the entry idle.

## Investigation

`restartEntry` sent SIGTERM and spawned the successor in the same tick. cloudflared's graceful shutdown lasts up to 30 s (`--grace-period`), and the user's wrapper holds an exclusive lock for the connector's lifetime so two connectors never serve one hostname, so the successor exited 1 ("already has a connector running") and `Tunnel restart failed` was terminal. The old connector finished exiting 30 s later and the box stayed tunnel-less until the app was restarted by hand.

## Decision

In `src/bun/cloudflare-tunnel.ts`, `restartEntry` waits for the old process (`waitForProcessGone`: exit promise, or PID polling for an adopted process) and escalates to SIGKILL after `TUNNEL_RECOVERY.oldProcessExitTimeoutMs`. A tunnel that was serving and went away — a failed restart, or its process exiting while `connected` — is retried by `scheduleRecovery` on a backoff (`TUNNEL_RECOVERY.retryDelaysMs`, capped at 5 min) with no attempt limit. Only an explicit stop ends it: `stopEntry` cancels the pending timer and bumps a per-id stop generation that in-flight restarts and recoveries check after every await; internal cleanup uses `teardownEntry`, which does neither. A headless server started with a tunnel that failed its first start keeps retrying via `retryMainTunnel`. A blank or not-found custom command is never retried.

## Risks

A recovered Quick Tunnel gets a new hostname; it propagates through the existing change hook, as watchdog restarts already did. Retrying forever means a permanently broken provider logs a retry every 5 minutes. SIGKILL skips cloudflared's graceful drain, which only matters for requests already in flight on a tunnel being replaced as unhealthy.

## Alternatives considered

Retrying only the failed restart a fixed number of times was rejected: outages outlast any small count, and the box has no other way back. Waiting the full 30 s grace period was rejected because it doubles the outage for a tunnel already declared unhealthy. Restarting the whole app from a supervisor works (and is what the user ran as a stopgap), but it drops every browser session to recover one child process.
