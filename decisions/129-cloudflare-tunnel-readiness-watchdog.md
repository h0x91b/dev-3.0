# Cloudflare Tunnel readiness watchdog

## Context

A Quick Tunnel hostname returned `NXDOMAIN` while its `cloudflared` child process remained alive and the Remote Access modal still reported the tunnel as connected. The existing manager treated the child PID and the first printed URL as sufficient liveness signals, then stopped reading `stderr` after startup.

## Investigation

The live process management endpoint returned `503` with zero ready connections, while its metrics reported one successful registration followed by 48 `server_error` registration failures. Because the post-startup `stderr` stream was no longer consumed, the daily app log contained the initial URL but none of the reconnect failures needed to explain the outage.

## Decision

`src/bun/cloudflare-tunnel.ts` drains and level-maps `cloudflared` output into the existing daily logger for the entire child lifetime. It parses the local management `/ready` endpoint, checks it every 10 seconds, and replaces the Quick Tunnel after three consecutive failures; rotated URLs propagate through the existing exposed-port push path and the open Remote Access modal polling loop.

## Risks

The management routes are diagnostic interfaces owned by `cloudflared`, so a future release could change their output or endpoint shape; failure to parse the startup line degrades to logging without automatic recovery. Restarting an anonymous Quick Tunnel necessarily rotates its hostname, so disconnected clients must use the refreshed URL or QR shown by dev-3.0.

## Alternatives considered

Watching only the child exit was rejected because the observed failure leaves the process alive indefinitely. DNS polling was rejected because it adds external resolver and cache ambiguity, while a named tunnel would provide a stable hostname but requires a Cloudflare account and is a separate product/configuration decision.
