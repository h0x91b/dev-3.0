# Tunnel recovery waits for the old process and retries until the tunnel is back

## Context

A headless box with a custom tunnel command served Cloudflare error 1033 for hours after a short network outage: the health monitor's restart failed once and nothing tried again, and a connector that exited on its own was never restarted at all.

## Investigation

`restartEntry` spawned the successor in the same tick it SIGTERMed the predecessor; cloudflared drains for up to 30 s and the user's wrapper holds a single-connector lock, so the successor exited 1 and the failure was terminal. A first fix kept retry state beside the tunnel map, and review found that every caller reading the map (task cleanup, `stopAll`, the Remote Access modal's "idle → auto-start") then missed a tunnel between attempts or mid-restart.

## Decision

In `src/bun/cloudflare-tunnel.ts` a lost tunnel keeps its slot as a placeholder entry (`placeholder: true`, state `starting`) carrying a `TunnelRecovery`; every caller sees it, an explicit start joins or hurries it, and only `stopEntry` ends it — each await re-checks slot ownership, and `releaseFailedStart` only releases its own entry. Attempts wait for the predecessor (`waitForPredecessor`, SIGKILL after `oldProcessExitTimeoutMs`) and back off without limit (`retryDelaysMs`), except a blank or not-found custom command, which is never retried for any kind; backoff restarts only once a recovered tunnel passes a health check or serves for `provenAfterMs`, and Cloudflare's 530 counts as down. A failed headless start and a self-update abandoned after stopping a wanted tunnel (`prepareHandoff` → `clearHandoff`) resume via `retryMainTunnel`.

## Risks

A placeholder reads as `starting` for the whole recovery — hours if the box is offline — so `isRemoteAccessActive()` keeps sleep prevention on and the update toast's auto-restart suppressed meanwhile; that is intended, since the tunnel is still wanted and a sleeping box cannot recover it. A wrapper whose own dependency is missing exits 127 and reads as a not-found command, which is not retried. A recovered Quick Tunnel gets a new hostname (propagated through the change hook); SIGKILL skips cloudflared's drain for a tunnel already declared unhealthy.

## Alternatives considered

A retry map beside the tunnel map was tried and rejected for the reason above, and a fixed retry count because outages outlast any small count. A separate `reconnecting` state was rejected for now: `starting` already means "not serving yet, coming up" everywhere the state is read. Restarting the whole app from a supervisor works, but drops every browser session to recover one child process.
