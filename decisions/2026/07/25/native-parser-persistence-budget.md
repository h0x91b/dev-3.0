# 169 — Native parser snapshot-persistence budget and queue pressure telemetry

## Context

The native-terminal live parser persists a full semantic screen plus capped
scrollback into `parser-state.json` on a 250 ms debounce. The seq 1262 load
harness measured that snapshot at ~1.6 MiB (80×24) to ~4.7 MiB (200×60) with a
full 200-line scrollback, so a busy wide pane could rewrite a multi-MiB file
~4×/s. The same harness could not observe the pipeline's queue depth at all —
`ParserEventQueue`'s counters were private, so the harness drove a mirror queue
that diverges from reality after the first overflow.

## Investigation

A real-PTY probe (`load-probe.ts`, 1/6/20 concurrent shells, macOS arm64, Bun
1.3.14) ran the pre-change policy against the new one. Legacy peaked at 2.6–3.9
snapshot writes/s per pane and 3.87 GiB of persisted bytes at 20 streams; the
queue itself never exceeded ~3 KiB of backlog. **Snapshot write volume, not
queue memory, is the real budget.**

The same probe on native Windows (Bun 1.3.14, real `powershell.exe`) confirms it:
legacy peaks at 1.28–2.05 writes/s, the new policy holds 0.48–0.52 across 1, 6,
and 20 streams, persisted bytes fall 2.8–3.9×, and queue high-water reaches
~65 KB — ConPTY chunks are far larger than on darwin, yet still 128× under the
8 MiB cap. Numbers are in `native-terminal-load-budget/FINDINGS.md`.

## Decision

In `live-parser.ts`: keep the 250 ms debounce as a latency floor and add
`DEFAULT_PERSIST_MIN_INTERVAL_MS = 1000` as a cadence ceiling (≤1 write/pane/s,
≈2.6 MiB/s worst case at 120×40); skip a write whose semantic payload is
byte-identical to the last one; allow at most one write in flight per pane, with
later dirty updates coalescing into a single re-armed write. `flush()` bypasses
both the ceiling and the skip so teardown always lands the latest state.
`queueCounters()` / `persistenceCounters()` / `resyncCounters()` publish the
resulting pressure read-only (depth, high-water, caps, `nominal` /
`slow-consumer` / `overflowed` verdict, write/skip/coalesce/byte accounting,
sequence gaps). `native-terminal-diagnostics` consumes them as optional inputs.

## Risks

A pane whose screen changes only in ways the semantic snapshot does not capture
would be skipped — accepted, because the snapshot IS the reconstruction
contract. The cadence ceiling widens the worst-case staleness of
`parser-state.json` from 250 ms to 1 s; reconnect fidelity is unaffected because
the journal, not the snapshot, carries the recent tail. The persisted format is
untouched, so every existing session file stays readable.

## Alternatives considered

Compressing the snapshot (adds a codec and breaks format compatibility); moving
state into a database (a whole storage dependency for one file per pane);
shrinking the scrollback cap for wide geometries (silently degrades reconnect
fidelity); a generalized write scheduler shared across panes (cross-pane
coupling for a per-pane problem). A per-pane coalescing rate policy is the
smallest thing that bounds the cost.
