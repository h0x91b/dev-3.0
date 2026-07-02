# Feature plan — Period navigation on the Velocity Cockpit

Status: `Observed` (shipped 2026-07-02)

## Job

Let the user browse **past** periods on the Productivity Stats cockpit — step back a day / week / month at a time and return toward the present — instead of only ever seeing the current rolling period.

## Feature class & scope

- Class: `data_visualization` control — **temporal navigation** of the existing time range (not a new filter, not config, not a mutation).
- Scope: page (the `stats` destination). Frequency: occasional. Risk: safe (read-only, ephemeral).

## Placement

- **Surface:** `stats_dashboard` header, right control cluster.
- **Position:** a `‹ label ›` stepper **immediately left of** the `TimeRangeSwitch`, before the Refresh button. The stepper's center label is the "what am I viewing" anchor; granularity switch + refresh are secondary utilities to its right.
- **Hidden** when range === `all` (stepping is meaningless for the lifetime view).
- Rejected: a date picker / calendar (operator console — violates the read-only celebration ethos + complexity budget); a separate nav row under the header (duplicates the time axis the range switch owns).

## Interaction

- `‹` steps one whole period into the past; `›` steps back toward now. Both are `icon` role, aria-labelled ("Previous period" / "Next period").
- Center label: relative text ("Today", "Yesterday", "3 weeks ago"); tooltip shows the exact date range. Click resets to the current period (disabled/inert at offset 0).
- Gating: `‹` disabled when no data precedes the shown window (`canGoOlder`); `›` disabled at the present (`canGoNewer`).
- Offset is **ephemeral** component state (not persisted) and **resets to 0 when the range changes**.
- Keyboard: buttons are Tab/Enter reachable; no new global shortcut (keeps the keymap registry untouched).
- Empty period: the whole-view empty state is gated on lifetime data, so a past period with zero activity still renders the cockpit with empty gauges/charts + per-section empty copy; the momentum headline reads "Nothing shipped in this period".

## Tokens / roles

- Stepper container mirrors `TimeRangeSwitch`: `border-edge`, `bg-raised`, `rounded-lg`. Arrow buttons `text-fg-3` → hover `text-fg`/`bg-elevated`; disabled `opacity-30`. Label `text-fg` semibold. No new tokens.

## Engine

- `computeProductivityStats(events, range, nowMs, offset = 0)` — `offset` shifts only the period window anchor (`nowMs - offset * periodSpanMs(range)`). Lifetime views (heatmap, streaks, all-time counters, rolling-average red zone) stay anchored to the real `nowMs`. Returns `offset`, `canGoOlder`, `canGoNewer`. `all` forces offset 0.

## Files

- `src/mainview/utils/productivityStats.ts`, `src/mainview/components/stats/PeriodStepper.tsx`, `src/mainview/components/ProductivityStatsView.tsx`, i18n `stats.nav.*`/`stats.rel.*`/`stats.periodPrev.generic`/`stats.momentum.idlePast`, tip `stats-time-travel`.

See `UX_DECISIONS.md` 2026-07-02 for the guardrail-interpretation rationale.
