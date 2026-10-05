# Sleep inhibit gets its own timer; the resource-monitor tick gets a watchdog

## Context
On 2026-10-05 the installed app logged `Sleep inhibit exited` after a hibernate wake and never restarted it until the app was relaunched. No poll error and no hung child was logged. The respawn ran inside `poll()` in `src/bun/resource-monitor.ts`, after an awaited tmux call, and `poll()` rescheduled itself only from its `finally`. Any await there that never settles ends both the monitoring and the respawn, silently. `ps` (`port-scanner.ts` `collectProcessInfo`) and `vm_stat`/`sysctl` (`system-memory-probe.ts`) had no timeout. The exact await that hung that day is not proven.

## Decision
- `startSleepInhibitWatch` in `src/bun/caffeinate.ts`: a synchronous `setInterval` tick (10 s) calling `updateCaffeinateState`. The remote-access check is loaded once and then read synchronously, so no tick waits on anything. `shutdownCaffeinate` stops the watch before killing the process.
- `runProbeText` in `src/bun/probe-spawn.ts` bounds the probes with the tmux module's `runBounded` (TERM, then KILL, then give up): 15 s for `ps`, 10 s for `vm_stat`/`sysctl`. An empty `ps` sample skips the tick instead of pushing zeros.
- The poll watchdog (`checkPollLoop`, every 15 s) abandons a tick older than 60 s, logs its `stage` (`tmux` / `process-table` / `system-memory`), and starts a fresh one. At most two abandoned ticks may be pending at once. Only the current tick reschedules, which also fixes the boost-during-tick double loop and a tick that rescheduled after `stopResourceMonitor`.

## Risks
- An abandoned tick that settles late may push one round of stale usage figures.
- A tick in flight across a system sleep is measured with `Date.now()`, so after a wake it can be flagged as stalled once. The cost is one warning line and one extra tick.
- `lsof` in `port-scanner.ts` is still unbounded, and the port poller has the same `finally`-only rescheduling. Left alone, because a timed-out `lsof` would read as "no ports" for every task.

## Alternatives considered
- Respawn from caffeinate's own `exited` handler: it cannot see the remote-access state without importing it, and it does not cover a respawn that was refused.
- Drive the poll from `setInterval` with an in-flight guard: it fights the 2 s / 10 s boost cadence, and it still needs the stall-abandon logic.
- Heartbeat logging on every tick: rejected as noise. The watchdog is silent while healthy.
