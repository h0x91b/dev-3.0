# Terminal-state snapshot benchmarks

Measured on 2026-07-20 with Bun 1.3.14, macOS 24.6.0 arm64, and an Apple M4 Max.
Each latency value covers creation of a fresh isolated Ghostty WASM instance,
event replay, and semantic inspection over 30 runs.

| Fixture | PTY input | Snapshot JSON | Ratio | Replay median | Replay p95 |
|---|---:|---:|---:|---:|---:|
| Active screen | 34 B | 266 B | 7.82× | 0.692 ms | 1.442 ms |
| Resize history | 14 B | 343 B | 24.50× | 0.814 ms | 1.084 ms |
| Bounded 400-line history | 39,778 B | 44,789 B | 1.13× | 16.645 ms | 17.415 ms |
| Real Neovim capture | 14,893 B | 20,075 B | 1.35× | 2.366 ms | 3.190 ms |

The small cases are dominated by versioned JSON metadata. The representative
history and TUI cases show the journal's structural overhead is modest, but the
snapshot still scales linearly with every byte ever emitted rather than with the
bounded terminal state.

Eight live Neovim replays retained an average of 24,923,063 external bytes
(23.77 MiB) and increased resident memory by 4,925,440 bytes (4.70 MiB) per
client. JS heap movement was below process-level measurement noise and was
clamped to zero by the benchmark. This is a conservative probe cost, not a
production target: each client uses a separate WASM instance to avoid the raw
shared-instance lifecycle corruption observed during the experiment.

Reproduce with:

```bash
bun run benchmark:terminal-state-spike
```

These are bounded comparative measurements, not release performance budgets.
Process-level memory sampling and a developer workstation introduce noise; run
the benchmark on target hosts before making capacity decisions.
