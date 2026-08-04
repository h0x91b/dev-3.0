# 205 — What can name the code that blocks the main loop

## Context

The app's main process goes fully unresponsive for seconds at a time — measured on a live
22-hour instance: one >250 ms block roughly every 11 seconds all day, worst individual
stalls 19 849 ms and 19 398 ms back to back, with **zero** log lines written during them.
The existing detector reports only that a tick was late, never what was running, so the
freeze investigated in seq 1407 could not be attributed. This spike answers one question:
what is the smallest mechanism that can name the blocking stack, and at what price.

## Investigation

Three candidates were measured on macOS arm64, Bun 1.3.14.

**`bun:jsc` sampling profiler — works.** JSC samples off-thread, so samples survive a
fully blocked loop: a 3 s block yields ~2 380 samples (~790/s) naming the blocking
function with its source URL and line. It also attributes a blocking **syscall** — the
shape the real suspect has — naming both `appendFileSync` and its caller. CPU overhead on
a tight JS loop measured at −0.3% rel., i.e. inside noise.

**macOS `sample` — useless here.** It needs no root and completes, but the Bun binary is
stripped and JIT frames carry no symbols: every frame reads `??? (in bun)` and the JS
function name appears zero times. `spindump` would add a root requirement to the same
dead end.

**`appendFileSync` is not the size problem it looked like.** Cost per append is flat in
file size — 24.9 µs at 0 MB, 24.5 at 101 MB, 23.8 at 400 MB, 29.2 at 831 MB. So an
827 MB day log costs nothing extra; only the *line rate* matters, and ~40 000 lines/s
would be needed to consume a whole second of the loop.

**The drain, not the sampling, is what costs.** The buffer accumulates rather than
ringing, so one drain after a 20 s stall materialises 27 756 traces and spikes RSS from
46 MB to 258 MB — ~10 MB of transient allocation per second of stall, enough to cause a
GC pause and so to become a stall itself. Undrained growth is far milder (+18 MB over
20 s), which points at a short drain cadence — except no tick runs *during* a block.

**So the only escape was a Worker, and the API forbids it.** A Worker does keep perfect
250 ms timing across a 20 s main-thread block: 80 of 80 batches ran. But all 80 threw
`Sampling profiler was never started`, while the main VM held 13 664 traces with the
needle. The inverse proves it symmetrically: with the Worker arming instead, its 80 drains
all succeeded (13 452 samples) yet **zero** contained the main-thread needle, and the main
VM then threw. A positive control — the needle name on the Worker's own stack — was found
in 20 of 20 batches, so those zeros are real negatives, not a broken check. The buffer is
per-VM: a Worker can neither read the main VM's samples nor arm it.

## Decision

**Parked. No product instrumentation with this API.** `bun:jsc` can name the blocking
stack, but nothing can bound the cost of collecting it at the stall lengths actually
observed, so shipping it would trade a 20 s stall for a diagnostic that causes its own.
The findings are pinned by `src/bun/__tests__/stall-attribution.bun-e2e.ts`
(`bun run test:stall-attribution-e2e`, 14 checks) so the experiment is not repeated and a
Bun release that lifts any limit fails loudly. Five limits are asserted: the sample rate
is **fixed** (an interval argument is accepted and ignored), there is **no stop** —
arming is a launch-time decision, `samplingProfilerStackTraces` is **absent from
`@types/bun`** and needs a local declaration, it **throws** rather than returning empty
when never armed, and the profiler is **VM-local**.

## Risks

Parking leaves the stalls unattributed, which is the honest state: the freeze in seq 1407
stays unconfirmed and the next recurrence will again produce no stack. Privacy is narrow
but not nil, should this ever be revisited: frames carry code identity only — no argument
values, no string contents, no user data — while `sourceURL` is an absolute path, so any
shipped profile must mask paths. Everything here was verified on macOS arm64 with Bun
1.3.14 only; Linux and Windows are assumed from JSC, not measured, and the VM-local
finding in particular should be re-checked after any Bun upgrade rather than trusted.

## Alternatives considered

The Bun inspector's CDP `Profiler` domain remains untried and is the one option left: it
reaches the same JSC profiler, but from outside the VM, so it may not share the VM-local
limitation that killed the Worker design — at the cost of a socket, a protocol client and
a launch flag. An external sampler was rejected on the evidence above: it cannot name JS
frames at all. Raising the existing detector's resolution was rejected as answering the
wrong question — more precise timing of *when* still says nothing about *what*. Accepting
the drain spike as-is was rejected because a diagnostic that stalls the loop it measures
cannot distinguish its own cost from the bug's.
