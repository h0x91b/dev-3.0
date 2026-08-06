# 215 — The Windows launch proof retries its process query instead of widening its budget, and polls liveness without WMI

## Context

`windows-proof-main` run 31098005022 **attempt 1** (`b88543d7c`) failed with
`Process snapshot failed (exit none, spawnSync …powershell.exe ETIMEDOUT)` at the first
`processSnapshot()` in `scripts/verify-windows-app-launch.ts`. The app itself had already
launched and written its readiness marker; only the query that inspects the process table
stalled. The upload step deliberately carries no `if:`
(`213-downloadable-windows-build-is-the-launched-tree.md`), so the downloadable Windows
build — the whole point of that change — was withheld from a launch that had succeeded.

Cite the run **with its attempt number**: a rerun overwrites the run-level conclusion, so
a bare `31098005022` now reads as green and argues for the opposite of this record.

## Investigation

- Bun honours `spawnSync`'s `timeout` to the millisecond (measured: 2002 ms for a 2000 ms
  budget), so the 60 s in the log is real and not a mis-measure.
- Nothing in `#1272` reaches the stalled call. Ruled out by reading: the retained unpack
  directory only changes where `tar.exe` extracts (the query enumerates processes, not
  files); the path change moves ~400 MB off `C:\…\Temp` onto the workspace disk, i.e.
  *less* pressure where it was before; no extra process is spawned; the pre-extraction
  `rmSync` is a no-op on a fresh runner.
- The red is **not stationary**: the same commit passed on attempt 2 (44.5 s total,
  ready 22.3 s, shutdown 20.4 s). Sample of two on a two-run workflow history — that is
  one observed stall and one clean rerun, **not a rate**, and no duration distribution
  exists at all.
- The proof issues far more of these queries than it looks: `alivePids()` ran a full
  PowerShell + WMI snapshot on every 500 ms poll of a 10 s graceful and a 20 s forced
  shutdown window — inferred ~15 PowerShell cold starts per run from `shutdownAfterMs`,
  against 2 that genuinely need parent pids.
- **The snapshot is not a diagnostic.** It underwrites the ready marker's pid being the
  launcher or one of its descendants, and "no owned process survived shutdown". Making its
  absence non-fatal would have weakened the proof while looking like a fix.

## Decision

1. **Attempts, not a bigger number.** `runProcessQuery()` retries a bounded number of
   times (3) at unchanged per-attempt budgets, and throws with a message naming the cause
   (the runner's query, not the app) and the fix. Raising the budget was refused: there is
   no distribution to size one from, and a budget picked to make one run pass is not a
   budget.
2. **The runs now produce that distribution.** Every attempt is timed into
   `processQueryStats` in `windows-app-launch-proof.json` and echoed in the summary line,
   so the next budget argument can be read off measurements.
3. **Liveness leaves WMI.** `alivePids()` uses `tasklist.exe /FO CSV /NH` — a native exe
   with neither a PowerShell start-up nor a WMI round-trip — because liveness needs pids
   only. `/FO CSV /NH` is chosen for locale-independence: tasklist translates its headers
   and unit strings, and `livePidSet()` throws rather than let an unparseable list read as
   an empty machine (that would report every owned process dead and pass a shutdown that
   never happened).

Seq 1450 independently dropped `Get-CimInstance Win32_Process` as its primary query in
favour of `Get-Process` for cost reasons. Two arrivals at the same conclusion; note the
limit of the shared evidence, though — the ETIMEDOUT wraps the PowerShell start-up **and**
the WMI round-trip, so this failure cannot by itself prove the WMI half is the expensive
one.

## Risks

- Three attempts at a 60 s budget means a genuinely dead query costs 180 s per tree walk
  instead of 60 s, inside a 35-minute job. Acceptable while there are two such walks.
- A stall that is not transient now takes 3× as long to be reported. The recorded
  durations are the mitigation: they say whether attempts helped or only postponed.
- `tasklist.exe` is not proven immune to the same stall class, only cheaper and free of
  WMI. It therefore gets the same bounded retry rather than a claim of immunity.

## Alternatives considered

- **Let the snapshot fail without failing the proof.** Rejected: it is an assertion, not a
  diagnostic (see Investigation). This would have shipped a build whose shutdown was never
  verified.
- **Raise the 60 s budget.** Rejected on principle stated above; also indistinguishable
  from doing nothing if the stall has no upper bound.
- **Upload the build on failure (`if: always()`).** Rejected — that is the guard from
  decision 213 working on its first real test, not a bug.
- **Replace the tree walk with `Get-Process` too.** It cannot report parent pids, and the
  two walks exist precisely to establish parentage.
