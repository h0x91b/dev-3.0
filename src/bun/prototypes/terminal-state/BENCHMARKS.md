# Terminal-state snapshot benchmarks

Measured on 2026-07-21 with Bun 1.3.14, macOS 24.6.0 arm64, and an Apple M4 Max.
Each latency value covers creation of a fresh isolated Ghostty WASM instance,
event replay, and semantic inspection over 30 runs.

| Fixture | PTY input | Snapshot JSON | Ratio | Replay median | Replay p95 |
|---|---:|---:|---:|---:|---:|
| Active screen | 34 B | 266 B | 7.82× | 0.509 ms | 0.770 ms |
| Resize history | 14 B | 343 B | 24.50× | 0.561 ms | 0.735 ms |
| Bounded 400-line history | 39,778 B | 44,789 B | 1.13× | 11.534 ms | 12.693 ms |
| Real PowerShell capture | 1,051 B | 1,620 B | 1.54× | 1.719 ms | 2.140 ms |
| Real Neovim capture | 14,893 B | 20,075 B | 1.35× | 1.580 ms | 1.947 ms |

The small cases are dominated by versioned JSON metadata. The representative
history and TUI cases show the journal's structural overhead is modest, but the
snapshot still scales linearly with every byte ever emitted rather than with the
bounded terminal state.

Eight live Neovim replays retained an average of 24,924,625 external bytes
(23.77 MiB) and increased resident memory by 5,316,608 bytes (5.07 MiB) per
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
