# A vitest test that fails by timeout keeps executing

## Context

The repo has a recurring class of flake where a suite fails under machine load with
an honest-looking assertion error in a test that has nothing wrong with it. The
cheapest example is `src/cli/__tests__/socket-client.test.ts`: every test in the
file bound the same unix socket path, `$DEV3_TEST_ROOT/socket-client.sock`.

## Investigation

Vitest records a timeout failure and moves on, but it cannot stop the test body —
JavaScript has no way to preempt a running async function. The body keeps
executing after the verdict.

The socket file made that visible, and the leak runs in both directions. Measured
on a quiet box (1-minute load 5.5 before and after, two runs of each arm):

| Fixture | `--testTimeout=60` | What failed |
|---|---|---|
| shared path | 4 failed / 10 passed | 3 timeouts **plus** `expected 4 to be 3` **plus** an unhandled `listen EADDRINUSE` |
| per-test path | 3 failed / 11 passed | the same 3 timeouts, nothing else |

The two extras are the mechanism. A timed-out `sendRequest` keeps retrying, so its
**zombie client** connects to a later test's server and inflates the connection
count that test asserts on — an honest assertion about real state, pointing at
innocent code. And the deferred `setTimeout` in the test at line 141 binds the
shared path after the successor already owns it, which throws `EADDRINUSE` out of
`listen` with no handler attached.

The window matters: at `--testTimeout=125` the same test still times out and
nothing collateral happens, because its server binds *before* the verdict and
`afterEach` then orphans it. The cascade needs the zombie's work to land after the
successor's setup.

Two consequences worth keeping:

- A **cascade** (one timeout plus assertion failures in later tests of the same
  file) is the signature of this mechanism. A run of pure timeouts is just load.
- A tightened `--testTimeout` turns a load-dependent version into a deterministic
  reproduction on a quiet machine. The value has to be tuned per file: 400 ms and
  125 ms both produced clean timeouts here and only 60 ms reproduced the cascade.

## Decision

Contain it by identity, not by cooperation. `test-scoped-path.ts` derives a
fixture path from the running test's name (`expect.getState().currentTestName`),
so two tests in one file can never hold the same path and a zombie cannot reach
its successor's resources. The result must be captured in a **local** const: a
module-level variable is re-read by the zombie's own closures, which hands it the
successor's path again and restores the bug.

`socket-client.test.ts` now calls `socketPath()` at the top of each test and
threads the path through `cleanSocket()` / `createMockServer()`. The one test with
a timer that outlives its own failure also cancels it from `signal`, the
`AbortSignal` vitest aborts on timeout.

The helper throws when a `.sock` path exceeds 100 bytes: the isolated run root
already eats ~82 of the ~104-byte `sun_path` budget, and overflowing it fails with
a bare `EINVAL` that reads like a broken fixture. The old shared path was 101
bytes — three from breaking — which is why the new fixture name is `s.sock`.

## Risks

Cooperation via `signal` only helps code that checks it; anything already inside a
blocking await keeps going. Identity isolation is therefore the load-bearing half,
and it only protects resources that are actually keyed per test — a fixture that
writes to a fixed path in a shared home directory has the same problem and is not
covered by this change.

## Alternatives considered

- **Making vitest stop the body.** Not possible; there is no preemption in JS.
  `signal` is the whole of what the runner can offer.
- **Retry or quarantine.** Rejected outright: it converts a possible product
  defect into a permanent blind spot, and here the underlying defect was in the
  fixture, which retrying would have hidden forever.
- **A `beforeEach` that assigns a unique path to a module-level variable.** Reads
  cleaner, does not work — see the local-const note above.
