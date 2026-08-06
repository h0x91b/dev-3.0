# Codex monthly credits come from app-server

## Context

Enterprise Codex rollouts expose `credits.has_credits` but leave the balance and primary/secondary windows null. The TUI still shows an effective monthly credit limit, usage, and reset time that users need in the existing rate-limit indicator.

## Investigation

Codex 0.143's stable `account/rateLimits/read` app-server method returns `individualLimit` with `limit`, `used`, `remainingPercent`, and `resetsAt`. The request must keep app-server stdin open until response ID 7 arrives; closing it immediately cancels the asynchronous account read after initialization.

## Decision

`src/bun/codex-rate-limits.ts` performs a read-only stdio handshake through the spawn wrapper, reads only response ID 7, and never persists account data. `rate-limit-monitor.ts` caches successful snapshots for five minutes, merges them over rollout data, and lets monthly utilization participate in the existing warning/danger calculation.

## Risks

The feature depends on a Codex binary, valid ChatGPT authentication, network access, and a compatible stable app-server schema. Every failure returns null, retains the last successful cache when available, and otherwise falls back to rollout-only behavior without breaking the header.

## Alternatives considered

Deriving credits from token pricing would not match server-side enterprise accounting. Polling the web dashboard or reading auth tokens directly would duplicate private APIs and expand the trust boundary, while spawning app-server every 30 seconds would create needless processes and requests.
