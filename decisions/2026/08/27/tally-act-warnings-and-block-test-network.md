# Tally act(...) warnings, gate debug traces, and block the network in renderer tests

## Context

One `bunx vitest run` over `src/mainview` printed **12 192 lines**. Measured composition:

| Source | Blocks | ~Lines |
|---|---|---|
| React act(...) boilerplate, 7 lines each | 680 | 4 760 |
| `[TerminalView]` / `[TaskTerminal]` / `[main]` / `[browser-rpc]` debug logs | ~450 | ~1 400 |
| `Failed to load spaces: getSpaces is not a function` + stack | 79 | ~950 |
| Google Analytics CORS refusals | 24 | 48 |
| `ECONNREFUSED 127.0.0.1:3000` dumps | 15 | 120 |

The backend and CLI suites were already clean (297 and 40 lines), so this is entirely a
renderer problem. At that volume a genuine warning is unfindable, which is the actual
cost — not the disk.

## Investigation

Two of the categories were defects wearing log-noise as a disguise.

`analytics.ts` asks `telemetryEnabled()`, and **nothing opts out under vitest**: the
build-time flag is unset, no host injects `window.__DEV3_TELEMETRY_OPT_OUT__`, and the
runtime toggle is off. So the suite really did dial Google Analytics and ipify from every
dev machine and every CI runner. happy-dom's CORS preflight failed, so no payload landed —
but the request left the box. Separately, importing `rpc.ts` is enough to POST `/rpc`,
which happy-dom resolves against its own default origin `localhost:3000` where nothing
listens.

The `getSpaces` gap was three hand-written RPC mocks (`App`, `ProjectSettings`,
`AddProjectModal`) that had drifted behind `useSpaces`. `TaskCard`,
`SpaceGroupedProjects` and the agent-traffic ledger were building lists without keys, or
with keys that collide when two messages share a millisecond.

For the act(...) warnings, fixing them at the source means converting every render helper
to `await act(async () => …)` and awaiting it at ~250 call sites across ~15 files. That is
a real improvement and a separate job; it is not log hygiene.

## Decision

Four changes, all in `src/mainview`.

1. **`test-setup.ts` tallies act(...) warnings** instead of letting React reprint the
   boilerplate: one line per test file naming each component and its count
   (`act(): updates outside act(...) — GlobalHeader×81, RateLimitIndicator×68`). The
   signal is kept in full at ~1% of the volume; the stray updates themselves are
   untouched and still visible per file. `_actOffenderForTests` handles the inlined and
   `%s` phrasings plus the suspense and post-teardown variants.
2. **`debug-log.ts` — opt-in renderer debug channels** (`terminal`, `rpc`, `boot`). ON in
   the app, OFF under vitest, either default overridable with
   `localStorage["dev3-debug"] = "terminal,rpc"` / `"*"` / `"off"`. The app keeps the
   traces it was written to have; the suite does not. `dev-server-trace.ts` drops its
   console mirror under test for the same reason — there is no bridge to lose there.
3. **`test-setup.ts` rejects every http(s) and origin-relative `fetch`.** No suite under
   `src/mainview` starts a server (no `Bun.serve`, no `createServer`), so nothing legitimate
   is lost, and a test that wants a response mocks it. This is the gate that stops the
   telemetry egress; the fix is deliberately at the transport rather than in
   `telemetryEnabled()`, because `telemetry-gate.test.ts` exists to assert the gate's
   default is ON and must keep asserting that.
4. **Recharts' `width(0) and height(0)` warning is dropped.** happy-dom has no layout
   engine, so every chart in every test is 0×0 and the warning can never carry information
   there.

Guarded by `src/mainview/__tests__/test-setup.test.ts` and
`src/mainview/__tests__/debug-log.test.ts`. Result: **589 lines, 4 818 tests green.**

## Risks

- The act(...) tally makes stray updates cheaper to ignore. Mitigated by keeping the
  per-file counts in the output rather than swallowing them; the counts are what a future
  cleanup will work down.
- Blocking `fetch` wholesale will bite the first test that legitimately wants a local
  server. It fails loudly with `network blocked in tests`, which names its own cause.
- The debug channel changes nothing in the app today, but a future reader of
  `[TerminalView]` logs has to know the override exists. It is documented in
  `debug-log.ts` and in the changelog entry.

## Alternatives considered

- **Fix all 680 act(...) warnings.** Correct, and ~250 mechanical edits across ~15 test
  files with real flake risk. Worth doing on its own; not worth bundling into a log cleanup.
- **Suppress act(...) warnings entirely.** Three lines, and it destroys a signal that
  predicts flakes in a repo that already has a flake problem.
- **Opt telemetry out inside `telemetryEnabled()` under vitest.** Cleaner-looking, but it
  inverts the default that `telemetry-gate.test.ts` is built to guard.
- **Delete the `[TerminalView]` logs.** They exist because terminal attach failures are
  painful to debug; taking them away from the app to quiet the tests is the wrong trade.
