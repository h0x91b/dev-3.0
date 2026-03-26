# 022 — Cross-Instance Task Status Sync via Socket Broadcast

## Context

Multiple dev-3.0 app instances can run simultaneously (dev3 is developed using dev3). Data files (`projects.json`, `tasks-*.json`) are shared, but push notifications only reach the instance whose socket handled the CLI request. Other instances show stale UI until manually refreshed.

## Investigation

Considered three approaches: file watchers (FSEvents), periodic polling, and socket broadcast. File watchers are unreliable across platforms and have edge cases with atomic writes. Polling adds latency and wasted cycles. Socket broadcast reuses existing infrastructure — each instance already has a Unix socket server.

## Decision

After any `taskUpdated` or `projectUpdated` push, broadcast a lightweight `_notify` NDJSON message to all other alive peer sockets in `~/.dev3.0/sockets/`. The receiving instance re-reads fresh data from disk and pushes to its local renderer only (no re-broadcast).

Key code paths:
- `src/bun/instance-broadcast.ts` — `broadcastToOtherInstances()` with 50ms debounce
- `src/bun/rpc-handlers.ts` — `getPushMessage()` returns broadcast-wrapped function, `getPushMessageLocal()` returns raw local push
- `src/bun/cli-socket-server.ts` — `_notify` handler re-reads from disk, calls `getPushMessageLocal()`

## Risks

- Disk read amplification: each broadcast triggers N-1 disk reads. Mitigated by debounce and small file sizes (typically < 100KB, always in OS page cache).
- Stale sockets: handled by checking PID liveness and cleaning up on ECONNREFUSED/ESRCH.
- Version skew: old instances return error for unknown `_notify` method; sender ignores errors.

## Alternatives considered

- **File watchers**: Rejected — FSEvents/inotify unreliable with atomic `rename()` writes used by the data layer.
- **Polling**: Rejected — adds 3-5s latency and constant disk activity for something that should be instant.
- **Shared event log file**: Rejected — over-engineered for the problem size (typically 1-3 instances).
