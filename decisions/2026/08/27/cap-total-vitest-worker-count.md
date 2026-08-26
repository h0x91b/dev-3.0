# Cap the total vitest worker count across the three concurrent configs

## Context

`bun run test` and `bun run test:full` start three vitest processes at once through
`concurrently` (mainview, bun, cli). None of the three configs set `maxWorkers`, so each
one independently takes the vitest default — `Math.max(availableParallelism() - 1, 1)`
(`node_modules/vitest/dist/chunks/cli-api.*.js`, `getDefaultThreadsCount`). On a 16-core
machine that is 15 workers each, roughly 45 worker processes on 16 cores, before any test
spawns a real `git` or `bash`.

The consequence is measurable: one uncapped run drives the machine's load average past
110 on its own, and the backend suite fails 1–2 tests on nearly every run — always
`Test timed out in 5000ms`, never an assertion.

## Investigation

Every number below is from this machine (16 cores, vitest 4.1.6). **The absolutes are
missing:** the box never went below a load average of ~8 during the measurement window,
because other agents were working on it and because an uncapped sweep run *is* the load.
What follows are paired, strictly alternating back-to-back runs, so every configuration
saw the same ambient noise. Round 1 and round 2 of the first sweep agreed within 2% on
all seven configurations, which is why the ordering is trustworthy even though the
seconds are not.

Sweep 1 — seven configurations, 4–5 runs each, ambient load 11–135:

| Total workers | Split (mainview/bun/cli) | Median wall | vs default | Runs with a starvation timeout |
|---|---|---|---|---|
| 45 (vitest default) | 15/15/15 | 31.1 s | — | **4 of 5** |
| 15 | 5/5/5 | 43.8 s | +41% | 0 of 4 |
| 9 | 3/3/3 | 63.2 s | +103% | 0 of 4 |
| 6 | 2/2/2 | 89.7 s | +188% | 0 of 4 |
| 4 | 2/1/1 | 131.7 s | +324% | 0 of 4 |
| 3 | 1/1/1 | 171.3 s | +451% | 0 of 4 |
| 15, three configs in sequence | 15 then 15 then 15 | 46.4 s | +49% | 2 of 4 |

Sweep 2 — the finalists, 6 runs each, alternating order, ambient load 88–125 (a
saturated box, so the seconds are worse across the board but comparable to each other):

| Total workers | Split | Median wall | Failing-test-file events over 6 runs |
|---|---|---|---|
| 45 (default) | 15/15/15 | 74.6 s | 63 |
| 15 | 5/5/5 | 84.7 s | 22 |
| 16 | 7/7/2 | 80.0 s | 17 |
| 23 | 10/10/3 | 71.5 s | 40 |

Five things came out of this:

1. **The default is the fastest and the least reliable.** Capping never buys wall-clock;
   it buys the suite finishing green. The 5 s timeouts are CPU starvation — zero
   `AssertionError` in any of them, and a failing set that moved between runs.
2. **Arseny's "4 total" instinct does not survive.** A total of 4 costs +324% wall-clock
   (31 s → 132 s) and is not measurably more stable than a total of 16. Nothing below
   about one worker per core buys anything.
3. **An even split wastes the budget.** 5/5/5 is slower than 7/7/2 despite using fewer
   workers: the cli suite finishes in ~4 s and its five slots then sit idle while
   mainview and bun crawl on five each. The shares have to follow the suite sizes
   (mainview 301 test files, bun 411, cli 50) — which is why the chosen budget is split
   4/4/1 rather than 3/3/3.
4. **Running the three in sequence at full width is not the answer.** It costs +49% and
   still produced timeouts in 2 of 4 runs, because 15 workers alone already saturate the
   box once other things are running on it.
5. **Wall-clock is not the metric the owner of the machine cares about.** Arseny picked
   the budget after reading this table, in his words: `делай 9.. +45% это терпимо, зато
   машина не жужит`. He was told the measured price of a total of 9 is +103%, not +45%,
   and kept 9. A test run that leaves the laptop usable is worth more here than 30
   seconds, so the budget below is deliberately quieter than the fastest safe option
   (a total of 15, at +41%).

The pre-existing flake in `components/__tests__/FolderPickerModal.test.tsx` appeared at
every cap level including the lowest, and fails on 2 of 3 *isolated* single-file runs, so
it is excluded from the attribution above. It is not caused by, and not fixed by, this
change.

## Decision

`test-workers.ts` (repo root) owns one budget of **9 workers on a 16-core box**, split by
suite weight — 4 mainview / 4 bun / 1 cli — and scaled linearly from
`availableParallelism()` so a smaller machine gets less and never drops below 3. `cli`
takes the remainder, so the three shares always sum to exactly the budget on any box
size. All three vitest configs read it through `resolveMaxWorkers(suite)`, and only
`bun run test` / `bun run test:full` turn it on, by exporting `DEV3_TEST_CONCURRENT=1`
before `concurrently`.

**The budget is a preference, not an optimum, and that is the point.** 9 is not the
fastest safe number — 15 is, at +41% instead of +103%. Do not "fix" it upward on
wall-clock grounds; it was chosen by the person whose fans spin.

Everything that runs **one** vitest process keeps the vitest default untouched:
`bun run test:bun`, `bun run test:cli`, `bun run test:watch` (its own default of half the
cores), and CI. **This deliberately does not apply in CI**, because CI does not have the
problem: `.github/workflows/build.yml` runs the three configs as three sequential steps
inside one shard job, so only one vitest process is ever alive and a cap could only take
parallelism away from a runner that has few cores to begin with. Nothing in CI exports
`DEV3_TEST_CONCURRENT`, so `resolveMaxWorkers` returns `undefined` there and the shard
job behaves exactly as it did before this change — no CI number was measured because
there is nothing in CI for this to change.

`DEV3_TEST_MAX_WORKERS=<n>` overrides the share for one process, which is how the tables
above were measured. `src/bun/__tests__/test-workers.test.ts` holds the wiring shut: it
asserts the shares, the per-suite `maxWorkers:` line in each config, and that the two
concurrent scripts — and only those two — export the flag.

## Risks

- **A future agent "helpfully" raises or removes the cap** because the default is faster
  on paper. That is what this record and the guard test exist to prevent: the default is
  faster *and* red, and 9 was picked over the faster 15 on purpose.
- **The 4/4/1 weights drift** as suites grow. They are relative weights, not absolute
  counts, so they only need attention if one suite's file count changes shape.
- **`cli` runs on a single worker.** Its 50 files take ~4 s at any width, so this is the
  cheapest place to spend the budget cut — but it is the first share to revisit if that
  suite grows.
- **The flag is inherited, not passed per command.** Anything that starts a single vitest
  process from inside a shell that already has `DEV3_TEST_CONCURRENT=1` set will be
  capped too. Acceptable: that shell is a concurrent test run by definition.

## Alternatives considered

- **`maxWorkers` in each config, unconditionally.** Rejected: three independent processes
  each capped at N still total 3N, and a solo `test:bun` would lose two thirds of its
  workers for nothing.
- **Run the three configs in sequence locally.** Measured, rejected: +49% wall-clock and
  still 2 of 4 runs red (row 7 of the first table).
- **One vitest `projects` config instead of three.** The architecturally clean answer — a
  single process with one real worker pool. Rejected for now on blast radius: the three
  configs each run `configureTestIsolation()` at module load with different roots, and CI
  shards each config separately with its own `--exclude` set. Worth revisiting on its own.
- **A shared limiter process.** Rejected: a new moving part to solve a problem two
  environment variables solve.

## Verification notes

- The cap is applied, not merely configured: during a real `bun run test:full` the three
  vitest parents had 4, 4 and 1 fork children (`pgrep -P`), against 15 at the default.
- Nothing is dropped by the cap: `vitest list` collects 4704 mainview / 7075 bun / 868
  cli tests with the budget on and with it off, identically.
- `bun run test:full` could not be taken green on this machine. Three suites time out
  (`git-merge-detection`, `git-worktree`, `git-diff-no-remote` — 23 timeouts, zero
  assertion failures) and a paired run of those same three files **with no budget set at
  all**, i.e. the pre-change behaviour, fails the same way (10 tests, 7 timeouts, zero
  assertion failures). They are the known load flake and the two suites already excluded
  from `bun run test` for their 146 and 102 real `git` spawns. Not caused by this change.
