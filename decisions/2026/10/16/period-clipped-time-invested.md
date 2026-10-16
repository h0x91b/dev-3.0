# Period-clipped "Time invested" on the Productivity dashboard

## Context

All three "Time invested" numbers were lifetime totals of the tasks **completed** in the window: `focusMs`, `statusDurations` (In Progress + AI Review) and `createdAt → movedAt`. An open task contributed zero, and a three-week task closed on the 1st put all its hours into the new month — "Total" in a 30-day window could exceed 30 days.

## Investigation

What is timestamped on disk: `Task.movements` (every column change since 2026-09-05, capped at 50 per task, `movementsDropped` counts evictions), `statusEnteredAt` (current status only, even on legacy tasks), `lifecycleStartedAt` (start of the last delivery cycle), `movedAt`. `statusDurations` and `focusMs` are cumulative counters with no time — they cannot be placed in a period. `tasks.json` is raw-parsed with no field whitelist, so an additive optional field survives older app versions.

## Decision

`src/mainview/utils/periodTime.ts` rebuilds each task's known status spans (`reconstructTimeline`) and clips them to the window and to now: **In flight** = Σ time launched and not closed (To Do and closed time excluded), **Agent time** = Σ time in In Progress / AI Review, plus the overlap-merged wall-clock. Sums are task-hours, so parallel tasks add up — the UI says so. Spans no timestamp covers are counted as gaps and reported ("N tasks have no status history…"), never estimated. Focus is now also recorded per clock hour: the tracker splits each tick at hour boundaries (`splitIntervalByHour`) and `addTaskFocusMs` merges it into `Task.focusByHour` (key = epoch hour, UTC). A bounded period sums the buckets whose start lies in it; `focusMs − Σ buckets` (history, older builds) is shown only under "All", the one window the counter is exact for.

## Risks

- Hour attribution by bucket start can move up to one hour of focus across a window edge (rolling windows rarely start on an hour).
- Hibernation has no timestamp, so a hibernated card in In Progress still counts as agent time; the dashboard names how many.
- An older build running alongside writes `focusMs` but not `focusByHour`, and moves tasks without logging; both surface as untimed focus / gaps, not wrong numbers.
- `focusByHour` grows by one key per distinct hour of attention per task (estimated at a few percent of the largest board file — not measured).

## Alternatives considered

- Spreading `focusMs` or `statusDurations` evenly over a task's lifetime — rejected: it fabricates history.
- A capped list of focus spans like `movements` — exact to the second, but frequent task switching evicts old spans and history goes holey.
- Only relabelling the old numbers — honest but leaves the dashboard unable to answer "how much time went into this period".
