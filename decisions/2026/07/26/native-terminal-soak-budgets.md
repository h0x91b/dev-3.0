# 172 — Native terminal soak: evidence-based budgets and a busy-tree crash fixture

## Context

Seq 1141 removes tmux. Before the native terminal host can carry a user's primary
terminal, it needs proof that it stays bounded and cleans up under multiple
concurrent sessions, sustained TUI-like output, reconnect churn, controller
restarts, host crashes, and repeated create/stop cycles — on real Windows. Seq
1301 adds that gate as an opt-in harness (`src/bun/native-terminal-soak/`,
`bun run test:native-soak`), deliberately outside `bun run test` and outside the
required PR checks.

Two things had to be decided honestly, because both invite a threshold big enough
to hide a real failure.

## Investigation

**1. Host RSS has a different pathological shape on each platform.**

- **macOS — a staircase.** A 25-cycle single-session run measured 194 → 229 MiB by
  cycle 4, flat for cycles 6–12, one step to 264 MiB at cycles 13–15, then
  263.9 … 264.4 MiB for the final ten cycles.
- **Windows — a sawtooth.** Working-set trimming swings host RSS between ~133 and
  ~213 MiB every few cycles with no trend whatsoever; in a 16-cycle four-session
  run, three of four sessions ENDED BELOW their first cycle (e.g. 173.7 → 132.8
  MiB).

Three statistics were measured against those real series before one survived. An
endpoint mean `(last − first) / (n − 1)` reports the macOS warm-up as ~6 MiB/cycle
of leak. A least-squares fit over the tail still reports ~4.5 MiB/cycle whenever a
single allocator step lands inside the window. A median of consecutive deltas
handles the staircase but is direction-asymmetric, so on the Windows sawtooth —
many small up-deltas, few large down-deltas — it reported a phantom 10.6 and 14.8
MiB/cycle "leak" on two sessions whose RSS was flat or falling. Theil–Sen (median
slope over every pair) reads all of them correctly: −2.1 … +0.8 on the four
Windows sawtooths, 0.1 on the macOS plateau, and exactly N on a synthetic
N MiB/cycle leak.

Anchoring the peak ceiling to the COLD post-warm-up baseline (~70 MiB) is equally
wrong: the parser core is empty there, so the normal cost of a full 1000-line
scrollback reads as a blow-up.

**2. A POSIX crash does not always reap a descendant.** With the nested shell
sitting idle at a prompt, force-killing the host orphaned its backgrounded
grandchild (`sleep`, observed with `PPID=1`, still alive). A shell blocked on a
read sees the hangup as plain EOF and exits normally, and a normal exit does not
send `SIGHUP` to background jobs. The same tree is reaped reliably when the shell
is busy in the foreground and therefore takes the signal — which is also what the
existing `crash-recovery.bun-e2e.ts` does, and why it never surfaced this.

## Decision

`budgets.ts`:

- The peak host-RSS ceiling is anchored to the **saturated** sample (taken right
  after a burst whose 1400 lines deliberately over-fill the 1000-line parser
  scrollback), not the cold baseline: `saturated × 2 + 64 MiB`.
- Growth verdicts use `theilSenSlope` over `tailWindow` — the **Theil–Sen trend
  across the second half** of the reconnect cycles. It is immune to isolated steps
  and symmetric in direction, which is what both real shapes require.
- A run shorter than `MIN_GROWTH_CYCLES` (16) yields an explicit
  `growth-unmeasurable` failure, and the tail window has a floor of
  `MIN_GROWTH_SAMPLES` (8). A short run can never look like a clean run. The
  documented default is 24 reconnect cycles, so the tail holds 12 samples.
- The full per-cycle RSS series is published in the summary
  (`perSession[].hostRssByCycle`), so a reviewer can re-derive the verdict instead
  of trusting the statistic.
- Journal and snapshot ceilings are derived from the writer's own cap and from
  `rows × cols + scrollback cap`, not chosen.

`workload.ts` / `run-soak.ts`: the crash phase runs `busyForegroundCommand` in the
nested shell so the owned tree is actively producing output when the host is
killed. On Windows the soak additionally asserts Job Object membership before the
kill and that the kill-on-close handle closed after it.

## Risks

The busy-tree fixture proves the realistic crash, and therefore does not assert
the idle-shell case, where POSIX orphans a background job. That is a real
platform limitation of signal-based ownership, unchanged by this work; Windows
does not share it because the token-named Job Object reaps by containment. If the
native backend ever ships as the default on POSIX, orphaned descendants of an
idle nested shell need their own mechanism (process group or cgroup), not a
louder test.

One allocator step landing dead-centre of a short tail window is genuinely
indistinguishable from a slow leak and is reported as growth; that is asserted as
intended behaviour in `budgets.test.ts` and is why the default run is long. Below
that resolution the peak ceiling and the fixed on-disk ceilings are the backstop.

## Alternatives considered

- **Absolute memory ceiling (e.g. 512 MiB/host).** Rejected: it is exactly the
  "huge threshold that hides failures" the gate exists to avoid, and it breaks the
  moment geometry or scrollback limits change.
- **Least-squares slope with a fixed warm-up prefix.** Tried, rejected: the warm-up
  length is load-dependent (3 cycles at one session, 6+ at three), so any fixed
  prefix either flakes or discards most of the run.
- **Median of consecutive deltas.** Tried, rejected on real Windows data — see the
  investigation above. It was the first statistic to pass macOS, which is exactly
  why the Windows run was required before the gate was called done.
- **Adding queue-depth counters to the wire protocol.** Rejected: protocol v1 is
  frozen (decision 154). The host already publishes RSS, parser health, overflow
  counters, and latency in `parser-state.json`, which the harness reads
  out-of-process — no production change was needed.
