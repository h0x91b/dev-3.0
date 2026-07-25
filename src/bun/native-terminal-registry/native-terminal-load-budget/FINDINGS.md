# Native-terminal stream budgets — findings (seq 1262)

Deterministic measurements produced by this harness over the **real** native
parser + resync primitives (`parser-queue`, `live-parser`, `journal`,
`parser-state`). A fake WASM core is injected through the pipeline's own
`createCore` seam; every counter below comes from a public primitive. Numbers
are reproducible run-to-run (seeded PRNG, fake clock, manual scheduler).

## Existing caps (asserted, not assumed)

| Cap | Value | Source |
|---|---|---|
| Parser queue bytes | 8 MiB | `DEFAULT_PARSER_QUEUE_MAX_BYTES` |
| Parser queue events | 65 536 | `DEFAULT_PARSER_QUEUE_MAX_EVENTS` |
| Journal rolling tail | 256 KiB | `DEFAULT_JOURNAL_MAX_BYTES` |
| Snapshot scrollback cap | 200 lines | `DEFAULT_SNAPSHOT_SCROLLBACK_CAP` |

## Snapshot size is the dominant budget

The persisted `parser-state.json` embeds a full semantic screen + capped
scrollback. Harness-measured serialized sizes (densely filled screen, empty
cell attributes — real content varies but the order of magnitude holds):

| Geometry | Scrollback | Snapshot |
|---|---|---|
| 80×24 | 0 | ~174 KiB |
| 80×24 | 200 (cap) | ~1.6 MiB |
| 120×40 | 200 (cap) | ~2.6 MiB |
| 200×60 | 200 (cap) | ~4.7 MiB |

Bounded, but **MiB-scale** for wide terminals at the full scrollback cap. The
pipeline persisted on a debounce alone (`DEFAULT_PERSIST_DEBOUNCE_MS = 250`), so
a busy wide terminal rewrote a multi-MiB file up to ~4×/s. Seq 1284 acted on
this: a 1 s cadence ceiling plus an identical-screen skip (see the before/after
section below and decision 169).

## Queue depth / drain iterations

- **Steady** (drain per frame): queue high-water = one frame; `drains` == frames.
- **Burst** (drain per cycle): high-water = one cycle's backlog; `drains` == cycles.
- **Stalled observer** (300×256 B fed, never drained): high-water = 75 KiB / 300
  events, well under both caps; a single scheduled drain then absorbs the entire
  backlog (`drains` == 1, `frames` == 300). Catch-up cost is one iteration, not one
  per frame — the deferred-drain design coalesces a stall into a single pass.

## Overflow & resync

- **Overflow** is explicit and terminal: the first dropped chunk flips the
  pipeline to `overflowed`, parsing stops, and post-verdict traffic is a bounded
  no-op (0 further drains). Byte-cap and event-cap paths both verified; dropped
  resizes are counted separately from dropped output.
- **Resync**: a stalled observer whose frames roll off the 256 KiB journal
  observes a **sequence gap** and resumes forward from the earliest retained
  frame — it never replays the hole. When the journal still covers the observer's
  watermark, the gap is zero and it resumes one past the watermark.

## Resolved follow-up — queue depth is now publicly observable (seq 1284)

The mirror `ParserEventQueue` is gone. `LiveParserPipeline` publishes
`queueCounters()` (depth, high-water, caps, `nominal` / `slow-consumer` /
`overflowed` pressure, slow-consumer episodes), `persistenceCounters()`
(writes, identical-skips, coalesced updates, failures, bytes, cadence), and
`resyncCounters()` (sequence gaps). The harness reads those production
primitives directly.

---

# Production budgets — before/after (seq 1284)

Measured with `load-probe.ts`, the **real-PTY** probe: real shells, real Ghostty
core, real atomic snapshot writes, real event loop. Each stream emits 1 200
scrolling lines, 1 500 idempotent redraws, then 6 s of once-per-second no-op
output. `--legacy` emulates the pre-seq-1284 policy (250 ms debounce only, no
cadence ceiling, no identical-skip).

    bun src/bun/native-terminal-registry/load-probe.ts <streams> 180 [--legacy]

Host: macOS arm64 (darwin), Bun 1.3.14, 120×40 panes, default caps.

| Streams | Policy | Writes | Skipped | Peak writes/s | Persisted | Queue high-water | Pressure | RSS peak | Health |
|---|---|---|---|---|---|---|---|---|---|
| 1 | before | 37 | 0 | 2.61 | 87.1 MiB | 480 B / 1 ev | nominal | 197 MiB | live |
| 1 | **after** | 17 | 6 | **0.81** | **37.5 MiB** | 1 024 B / 1 ev | nominal | 203 MiB | live |
| 6 | before | 262 | 0 | 2.45 | 606.7 MiB | 1 066 B / 1 ev | nominal | 530 MiB | live |
| 6 | **after** | 135 | 36 | **0.85** | **308.0 MiB** | 1 125 B / 1 ev | nominal | 568 MiB | live |
| 20 | before | 1 766 | 0 | 1.95 | 3 866.3 MiB | 1 035 B / 1 ev | nominal | 1 544 MiB | live |
| 20 | **after** | 772 | 120 | **0.90** | **1 752.6 MiB** | 1 024 B / 1 ev | nominal | **1 187 MiB** | live |

Reading of the numbers:

- **Snapshot write volume was the real budget, not queue memory.** The queue
  never exceeded ~3 KiB of backlog in any run — four orders of magnitude under
  the 8 MiB cap — while persisted bytes reached 3.9 GiB at 20 streams.
- **The cadence ceiling holds.** Peak per-pane write rate drops from 1.95–2.61/s
  to ≤ 1.0/s everywhere, exactly the documented `DEFAULT_PERSIST_MIN_INTERVAL_MS`.
- **Identical-skip pays off during quiet output.** The 6 s no-op tail produces
  exactly 6 skipped writes per stream (6 / 36 / 120 across the fleets) — output
  keeps flowing, the disk stays idle.
- **Persisted bytes roughly halve** (2.3× / 2.0× / 2.2× less) with byte-identical
  reconstruction, and RSS at 20 streams drops 1 544 → 1 187 MiB.
- **Drain iterations, watermark, sequence gaps (0), health (`live`), and cleanup
  are unchanged** — the policy touches persistence, not parsing.

Every run ended with `stateDirRemoved: true` and every child reaped, i.e. the
teardown path flushes the latest state and leaves nothing behind.

## Native Windows run — Bun 1.3.14, real `powershell.exe`

Same probe on native Windows (win32, Bun 1.3.14, 120×40), sized up so the shell
actually saturates the cadence window:

    $env:DEV3_LOAD_PROBE_LINES = "6000"
    $env:DEV3_LOAD_PROBE_REDRAWS = "8000"
    $env:DEV3_LOAD_PROBE_TAIL_SECONDS = "8"

| Streams | Policy | Writes | Skipped | Peak writes/s | Persisted | Queue high-water | RSS peak | Elapsed |
|---|---|---|---|---|---|---|---|---|
| 1 | before | 24 | 0 | **1.96** | 60.4 MiB | 8 343 B | 203 MiB | 12.3 s |
| 1 | **after** | ≈6 ¹ | ≥1 ¹ | **0.48** | n/a ¹ | 6 723 B | 221 MiB | 12.6 s |
| 6 | before | 165 | 0 | **2.05** | 415.4 MiB | 18 387 B | 910 MiB | 13.8 s |
| 6 | **after** | 42 | 56 | **0.52** | 105.6 MiB | 24 219 B | 875 MiB | 13.6 s |
| 20 | before | 399 | 0 | **1.28** | 936.0 MiB | 65 618 B | 1 598 MiB | 17.1 s |
| 20 | **after** | 143 | 263 | **0.50** | 339.7 MiB | 65 610 B | 1 529 MiB | 16.8 s |

¹ That single per-stream record was truncated in transit; `writes` is derived
from the reported 0.476 writes/s over 12.6 s and `snapshotTotalBytes` is
unrecoverable. The 6- and 20-stream fleets carry the same conclusion with
complete records.

Every Windows run reported `ok: true`, `health: live`, `pressure: nominal`,
`snapshotFailures: 0`, `snapshotCoalesced: 0`, `resyncGaps: 0`,
`stateDirRemoved: true`, and reaped every child.

- **The cadence ceiling binds and holds.** Legacy peaks at 1.28–2.05 writes/s per
  pane; every `after` run sits at 0.48–0.52, comfortably inside the documented
  1/s ceiling.
- **Identical-skip pays off on Windows too:** at least 9 skips per stream at 6
  streams and 11 at 20 streams (56 and 263 in total), against 0 under the legacy
  policy.
- **Persisted bytes fall 2.8–3.9×** (415 → 106 MiB at 6 streams, 936 → 340 MiB at
  20) for byte-identical reconstruction, and RSS peak drops 1 598 → 1 529 MiB at
  20 streams.

**Windows-specific data point worth keeping:** queue high-water reaches ~65 KB on
Windows versus ~1 KB on darwin — ConPTY delivers far larger chunks per callback.
Still 128× under the 8 MiB cap, and pressure never left `nominal`.

**A lone carriage return is not observable output on ConPTY.** An earlier tail
phase emitted a bare `\r`; on Windows that produced no data callback at all, so
no drain, no persist attempt, and neither a write nor a skip was counted — the
skip column read 0 and looked like a policy failure. The tail now reprints a full
steady line, which is byte-identical on screen but genuinely emits bytes. Any
future probe phase meant to exercise a no-op path must emit printable output.
