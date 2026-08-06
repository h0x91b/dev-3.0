# 207 — The renderer ready budget is sized off a measured distribution, not a sample

## Context

`windows-app-archive` (`.github/workflows/windows-conpty-package.yml`) went red on
run 31049142202: the packaged app started, logged `=== dev-3.0 ready ===`, then
its own readiness watchdog fired 45 s later and the app exited 8
(`DEV3_DESKTOP_RENDERER_UNAVAILABLE`). The 45 s came from decision 177, justified
as "~30x the observed cost" against two samples — 366 ms on an interactive
desktop and 1511 ms in the packaged proof.

## Investigation

The proof already records `readyAfterMs` (spawn → dom-ready) and CI uploads it,
so the distribution existed and had never been read. 40 green
`windows-app-archive` proofs on GitHub-hosted `windows-latest`:

| min | median | p90 | p95 | max |
|---|---|---|---|---|
| 4 036 ms | 11 128 ms | 18 702 ms | 24 825 ms | 40 534 ms |

The slowest healthy launch is **40.5 s** against a 45 s budget — about 10%
headroom, not 30x. The 1511 ms sample was a fast run, and the packaged launch on
a shared runner is an order of magnitude slower and ten times as wide. The
failing run's log shows the runner crawling (`spawnSync` of `which` at 1881 ms,
a 3304 ms event-loop stall).

Two things this investigation refuted rather than confirmed:

- **The three other red runs in the last 25 are unrelated.** Their
  `windows-app-archive` jobs all passed; they failed in `package-runtime` on
  different E2E steps. This failure has one occurrence, not four.
- **Extending the budget by measured event-loop stall time would not have
  helped.** The failing run stalled for 3.3 s inside a 45 s window, so a
  "45 s of healthy wall clock" budget would still have fired.

What remains unproven is whether that run was an extreme tail (>52 s spawn →
dom-ready) or a genuine no-renderer condition. Both are handled: the marker now
carries the measurement, so a tail shows up as a large `rendererReadyMs` in a
green proof, and a genuine no-renderer still fails, 180 s later.

## Decision

- `RENDERER_READY_TIMEOUT_MS` 45 s → **180 s** (`src/bun/renderer-readiness.ts`),
  ~4.4x the slowest measured healthy launch and still bounded.
- The watchdog reports `elapsedMs` as `null` when it was never armed
  (macOS/Linux) instead of a fake `0`, and `writeAppReadyMarker` records it as
  `rendererReadyMs` in the ready marker. `index.ts` writes the marker from the
  watchdog's `onReady`, where the measurement lives.
- `scripts/verify-windows-app-launch.ts` requires `rendererReadyMs` to be a
  non-negative number for a marker to count, surfaces it in
  `windows-app-launch-proof.json`, and derives its own poll budget as
  `RENDERER_READY_TIMEOUT_MS + 60 s` so a rendererless launch always surfaces
  the app's actionable diagnostic rather than the script's generic timeout.

## Risks

- **This is a trade, not a pure win: the slow case was made to work by making
  the broken case fail slower.** A user whose WebView2 is broken, or who launched
  with no interactive desktop, now waits 3 minutes instead of 45 s — and during
  that wait there is **no signal at all**. The native window is created and stays
  blank (that is the whole failure: the renderer that would draw anything is
  exactly what is missing); there is no splash, no progress indicator, no
  notification. The diagnostic goes to stdout and to
  `~/.dev3.0/logs/<yyyy>/<mm>/<date>.log`, and a double-clicked Windows launch has
  no console — so what that user actually sees is a blank window for 180 s and
  then nothing. Accepted deliberately: a false "you have no UI" on a working
  machine is worse than a slow true one. A visible signal during the wait is real
  missing work, reported separately rather than bolted onto this change.
- 180 s is itself an estimate. It is falsifiable: `rendererReadyMs` is now in
  every uploaded proof, so the next re-tune reads the distribution.

## Alternatives considered

- **A bounded retry of the launch in the verify script** — rejected. A retry
  turns a 50%-reproducible real regression green, which is exactly the failure
  this job exists to catch.
- **A workflow-level `retry` on the job** — rejected for the same reason, and it
  would mask every unrelated failure in the same job.
- **Charging the budget only for non-stalled time** — refuted by the data above.
- **A CI-only env override (`DEV3_RENDERER_READY_TIMEOUT_MS`)** — rejected: the
  45 s number is wrong for real slow or loaded Windows machines too, not only
  for CI. Hiding that behind a CI variable would leave a false
  "no renderer" exit in shipped builds.
