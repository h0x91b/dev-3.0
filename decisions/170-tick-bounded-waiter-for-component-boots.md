# 170 — Tick-bounded waiter for component boots instead of `waitFor`

## Context

`TaskDiffViewer.test.tsx > defaults to split mode, opens files by default, and
lets a file be marked as read` failed on CI shard 5/5 with
`Unable to find an element by: [data-testid="mock-diff"]` after 1272ms, on a
branch whose whole diff was `AGENTS.md` plus a changelog entry. Shards 1-4 were
green and every other test in the same file passed at normal speed.

## Investigation

The viewer's boot is a chain, not one await: `getGlobalSettings` → view mode,
`getTaskDiff` → payload, three dynamic `import("@git-diff-view/*")` → diff lib,
then one `setTimeout(…, 0)` per rendered file that builds the `DiffFile` and
finally renders `<DiffView>`. Each link is a separate macrotask plus a React
effect pass.

RTL's `waitFor` gives up after 1000ms of **wall clock**. Locally that boot takes
37-48ms and the file never failed (0/25 repeats of the single test, 3 full-suite
runs, and repeats under 24-40 CPU hogs — CPU starvation alone only pushed it to
~130ms). CI is ~3-4x slower than this machine on the file's other tests, which
does not explain a 20x blow-up on one test — the honest conclusion is a stall of
unknown origin (GC pause, runner IO, scheduler) hitting the one test that also
carries the file's cold start.

Reproduced deterministically by chaining six 200ms-stalled macrotask hops into
the `getTaskDiff` mock: with `waitFor` the test fails at 1070ms with the exact CI
error; with the tick-bounded waiter it passes at 1321ms. A single synchronous
stall does **not** defeat `waitFor` (its 50ms poll fires before its own timeout
once the loop frees up) — it takes a boot whose hops each land late, which is
what a contended runner produces.

## Decision

`src/mainview/test-utils/wait-for-ticks.ts` exports `waitForTicks(query, maxTicks
= 60)`: it retries the query, yielding one real macrotask inside `act()` between
attempts, and gives up after a bounded number of **ticks** rather than
milliseconds. Machine slowness therefore cannot fail it; only a DOM that never
settles can. All 28 `mock-diff` waits in `TaskDiffViewer.test.tsx` use it.

`test-retry.ts` adds `retry: { count: 3, delay: 50 }` on CI only (wired into all
three vitest configs) as a net for stalls in suites still on `waitFor` —
including the known bun-side temp-repo git flakes, which are a different root
cause. Retries stay off locally so a new flake is visible immediately.

## Risks

- A tick loop hides genuinely slow production code: a boot that regressed from 5
  to 500 macrotask hops still passes (under the 60-tick cap it does not, which is
  the guard).
- `waitForTicks` does not advance the clock, so it must never be used for waits
  that depend on a real delay (debounces, the viewer's 300ms loading state).
- CI retries can mask a real async regression that fails ~1 in 4 runs.

## Alternatives considered

- **Raise `asyncUtilTimeout` globally** — moves the deadline, keeps the wall-clock
  race; the flake returns on a slower runner.
- **Fake timers for the whole file** — fully deterministic, but 3500 lines of
  `userEvent` + rAF + MutationObserver would have to be converted.
- **`beforeAll` warm-up render** to move cold start out of the timed window —
  measured no effect (warming the dynamic imports left the first test at 114ms vs
  116ms), so the cold start is not the import graph.
- **CI retries only** — cheapest, but a real async regression would pass silently.
