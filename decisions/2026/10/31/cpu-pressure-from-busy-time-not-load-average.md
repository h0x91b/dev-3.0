# CPU pressure from busy time, not load average

## Context
The header CPU pill (#2084) showed the 1-minute load average as a % of the core count and judged warn/critical on it. A user saw "633% · overloaded" while the same snapshot said the cores were 30% busy (load 101.25 on 16 cores).

## Investigation
Busy % and load % are computed in the same poll tick and arrive in one `SystemLoadSnapshot`, so the push was fresh — the metric was wrong, not stale. On macOS the load average counts runnable *and* uninterruptible (I/O-blocked) threads — Spotlight, `find`, cloud-drive sync, VMs — so it can sit far above the core count on an idle CPU, and as a 1-minute EWMA it stays high for minutes after a real spike.

## Decision
`classifyCpu` (`src/bun/system-load.ts`) judges `cpuBusy` (sampled core times between polls); the pill and popover headline show busy %. Load average stays in the popover as secondary text and is never classified. `SystemLoadSnapshot.cpuLoadPercent` is removed. The settings keys are new — `cpuBusyWarnPercent` / `cpuBusyCriticalPercent`, defaults 80 / 95, choices capped at 100 — because an old `cpuWarnPercent: 150` means nothing on a 0–100 scale; silently reinterpreting it would either never fire or fire at the wrong point.

## Risks
A user's custom CPU levels from the previous version are dropped back to the new defaults (the old keys are ignored and disappear on the next settings save). A short burst fills one 10 s (2 s while boosted) window and can flash the pill — that is a real CPU spike, unlike the load-average case.

## Alternatives considered
Keep load average but divide by a larger factor — still inflated by I/O waits and still lags. Show `max(busy, load)` — inherits the same false positives. Reuse the old keys with a clamp to ≤100 — ambiguous meaning for values like 100 that were valid on both scales.
