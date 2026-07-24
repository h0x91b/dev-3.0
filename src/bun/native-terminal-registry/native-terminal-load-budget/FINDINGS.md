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
pipeline persists on a debounce (`DEFAULT_PERSIST_DEBOUNCE_MS = 250`), so a busy
wide terminal rewrites a multi-MiB file up to ~4×/s. Integration work should
budget disk churn accordingly (e.g. skip re-persist when the semantic screen is
unchanged, or shrink the persisted scrollback cap for wide geometries).

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

## Follow-up — queue depth is not publicly observable on the pipeline

`LiveParserPipeline` exposes `overflow`/`overflowed` (post-hoc) and `watermarkSeq`,
but **not** the live queue depth or its high-water mark (`ParserEventQueue`'s
`pendingBytes` / `pendingEvents` are private to the pipeline). The harness works
around this by driving a mirror `ParserEventQueue` with the same caps and the
identical frame stream, which is faithful only until the first overflow diverges
the two.

Recommendation for the integration work (not done here — this task must not edit
the pipeline): expose a read-only queue-depth / high-water accessor on
`LiveParserPipeline` (or fold `queuePendingBytes` / `queueHighWaterBytes` into the
snapshot's health block) so real backpressure telemetry does not need a mirror.
