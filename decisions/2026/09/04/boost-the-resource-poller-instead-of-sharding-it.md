# Boost the resource poller instead of sharding it

## Context

The tmux Sessions popover shows CPU and RSS per session. The request was to make the readout
live: split the sessions into 5 shards and refresh one shard every 250 ms, so a full pass lands
every ~1–2 s.

## Investigation

The numbers do not come from the popover's own RPC. `listTmuxSessions`
(`src/bun/rpc-handlers/tmux-pty.ts`) reads `getResourceUsage()`, a cache filled by the
resource-monitor poller (`src/bun/resource-monitor.ts`) on a 10 s tick. That tick does **one**
`ps -eo pid=,ppid=,rss=,%cpu=,args=` over the whole process table and aggregates every session
from that single sample.

Measured on the maintainer's machine (1270 processes): one such `ps` costs ~120 ms of CPU.

So per-session sharding buys nothing — a single `ps` already covers all 62 sessions, and there
is nothing left to split. Refreshing a shard every 250 ms would mean four full `ps` calls per
second, ~50% of a core for as long as the popover stays open, for the same 2 s freshness.

Second finding, unrelated to the request but blocking the feature: the desktop entry wired the
monitor's push through `broadcastToAllWindows` only (`src/bun/index.ts`), so
`resourceUsageUpdated` and `systemMemoryUpdated` never reached a remote browser or phone.
Measured in a browser session: `taskUpdated` arrived, those two never did — the boosted tick was
invisible there until it was fixed.

That fix is **not** this change's. It was carried independently by PR #1650 (`pushEverywhere()` in
`src/bun/push-targets.ts`, plus a guard test that fails on a bare fan-out call in `index.ts`),
which merged first as `6d3058321`. This branch was rebased onto it and its own variant dropped, so
there is one way to push. The measurement above is kept because it is the evidence that the gap was
real and that this feature depended on closing it.

## Decision

While a surface watches the numbers, the poller itself goes fast — no shards.

- `boostResourceMonitor()` / `clearResourceMonitorBoost()` in `src/bun/resource-monitor.ts`
  switch the tick between 10 s and 2 s, and pull the next tick forward so opening the popover
  does not wait out the remainder of a slow interval. The boost carries a 15 s TTL and must be
  renewed: the watcher may be a browser tab that vanishes without ever saying stop.
- A boosted tick asks `collectProcessInfo({ maxAgeMs })` (`src/bun/port-scanner.ts`) for fresher
  data than the shared 5 s cache, or it would render one sample three times and call it live.
- `setResourceMonitorBoost` (RPC) is renewed on a 5 s heartbeat by `TmuxSessionManager` while its
  popover is open and cleared when it closes.
- `startResourceMonitor` in `src/bun/index.ts` pushes through `pushEverywhere()`, which #1650 put
  there. Without it the fast tick reaches native windows only, so the live readout would work on
  the desktop and be frozen in a browser or on a phone.

Cost while open: one `ps` every 2 s, ~6% of a core — an order of magnitude under the shard
scheme, at the same freshness. Verified in a browser: 2.2 s push gaps sustained over 21 s with
the popover open, 10.3 s within seconds of closing it.

## Risks

- A client that renews the boost but never closes it holds the fast tick as long as it lives.
  That is the intent (the list is on screen), and the TTL bounds the damage of a client that
  disappears.
- Sorting re-runs on every push, so rows reorder under the cursor while the list is open. That is
  deliberate — the list answers "what is eating the machine", so the heaviest must stay on top.

## Alternatives considered

- **5 shards at 250 ms, as asked.** Rejected on the measurement above: 8× the CPU for the same
  freshness, plus per-shard bookkeeping in both processes.
- **A separate per-session `ps` for the visible rows only.** Cheaper per call, but `ps` for a PID
  tree still enumerates it, and the session's real cost is the descendants — the whole-table
  sample is what makes the aggregation correct.
- **Leave the 10 s tick and only re-fetch the list faster.** The popover would poll a stale
  cache: fresher renders of the same numbers.
