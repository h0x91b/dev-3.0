# PR detection poller: per-task timeouts, single tick, watchdog

## Context
The PR detection poller (`startPRDetectionPoller` → `checkOpenPRsForPromotion`, `src/bun/lifecycle/activities.ts`) once ran for ~9.5 hours without writing a single PR status, while the app kept serving RPCs, and `dev3 pr watch` notices arrived hours late or never. The tick was `setInterval(async …)` with no in-flight guard, and it awaited each task in turn with no deadline. Only the GitHub read itself was bounded (15 s). A hung git call, file lock, dispatch or pane delivery on one task never ran its `finally`, so `prNextDue` stayed in the past. Every following tick walked into the same task and froze behind it, and the overlapping ticks piled up.

## Investigation
Which await actually hung was never proven. So the fix both bounds every layer and records where a poll waits (`PollTrace.stage`: `current-branch`, `unpushed-count`, `github-read`, `dispatch-pr-detected`, `merge-covers-head`, `merge-offer`). The timeout and watchdog log lines name that stage.

## Decision
- `pollTaskWithinDeadline` caps one task at `PR_TASK_POLL_TIMEOUT_MS` (60 s). A timed-out poll keeps running detached, and the task is skipped with a warning (not stacked) until it settles. It is rescheduled as usual.
- `runPRDetectionTick` lets only one tick run at a time. A tick older than `PR_TICK_STALL_MS` (5 min) is abandoned through a generation counter: the old tick stops at its next project or task boundary, and a fresh tick starts and logs an error. A heartbeat (`PR_POLLER_HEARTBEAT_MS`, 10 min) logs the counters.
- `reportTaskPrStatus` no longer awaits `runPrWatches`; it starts the run detached (`startPrWatchRun`). The merge-offer hold logic is order-independent: `mergeOfferHeld` creates the hold, and a delivered "merged" notice then refreshes it with the notice text.
- `runPrWatches` takes over from a run still in flight after `PR_WATCH_RUN_STALL_MS` (3 min) instead of skipping it forever. Each evaluation and delivery is logged at info.

## Risks
JavaScript cannot cancel a hung await, so an abandoned poll or run may still finish later. Its writes are the same idempotent dispatches a normal poll makes. A watch-run takeover could in theory deliver one notice twice if the stalled run later completes its send. The info logs add roughly one row per watching task per minute.

## Alternatives considered
- A timeout on every individual git call: broader and still leaves unbounded awaits (locks, dispatch, delivery). The per-task cap covers all of them at once.
- Running tasks in parallel: removes head-of-line blocking but multiplies git and GitHub load, the problem the throttled schedule exists to avoid (`git-poll-throttle.ts`).
- Restarting the whole poller from an external watchdog: loses the per-task diagnosis and does not stop the same task from wedging the next tick.
