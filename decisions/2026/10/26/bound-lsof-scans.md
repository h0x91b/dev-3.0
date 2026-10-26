# Bound every whole-system lsof scan, and keep the port poller to one chain

## Context

A production app (1.61.0) ran 10-20 concurrent `lsof -i -P -n -sTCP:LISTEN -F pcn` scans, each burning most of a core, with load average above 120. Every one was a direct child of the app's bun process.

## Investigation

`schedulePortScanSoon()` (called on every dev-server run/stop) cleared `pollTimer` and armed a new timer. While `poll()` was running, `pollTimer` still held the already-fired handle, so the clear was a no-op and the new timer started a second poll chain; the running cycle's `finally` re-armed its own chain too. Every dev-server action during a cycle added a permanent chain. The app log showed one `Port scan poller started`, 19 dev-server run/stop calls, and no dev-server RPC in flight while the scans piled up, which leaves only leaked poll chains as the source. A single `lsof` scan measured 70 s wall time (45 s sys) under that load, so a cycle was almost always in flight and almost every action leaked. Separately, `lsof` forks a helper child that keeps running after its parent gets SIGTERM (reparented to launchd, same process group).

## Decision

- `port-scanner.ts`: one chain only. A generation counter retires a chain on stop/start, and a reschedule request during a running cycle is stored and applied by that cycle's `finally` instead of arming a second timer. Stopping aborts the running scan.
- `scanListeningSockets()` is single-flight (callers share the running scan) and bounded at `LISTEN_SCAN_TIMEOUT_MS` (20 s). It returns null when it was not measured. The poller then keeps every task's last known ports and backs off exponentially, capped at 120 s, instead of publishing an empty list.
- `lsof-scan.ts` runs every whole-system lsof (LISTEN and the reaper's cwd scan, 30 s) in its own process group via `runBounded({ processGroup })`. A stop sends TERM to the whole group, then KILL, so the helper child goes too.

## Risks

On a machine where a healthy scan takes more than 20 s, ports stop refreshing. The warn log `Port scan skipped: lsof did not answer` shows when that happens. A timed-out cwd scan reaps nothing for that teardown. This is deliberate: guessing which processes to kill is worse than leaving some behind.

## Alternatives considered

Killing the stray lsof processes in the running app: rejected. Each leaked chain spawns a new scan 10 s later, and a killed scan used to read as "no ports". A plain `Promise.race` timeout: rejected, because it abandons a process that keeps running. Killing only the lsof parent: rejected, because its helper child keeps running.
