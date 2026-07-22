# Live-parser Windows matrix (seq 1228 / STATE-005)

Proves on a native Windows host that the registry host maintains a real Ghostty
screen while Bun.Terminal streams ConPTY output, with parsing deferred outside
the data callback (decision 155), parser replies written back to the same PTY,
and detach-boundary reconstruction from the bounded parser state.

This is proof tooling around the isolated registry. Nothing here is imported by
production; it does not touch tmux, backend selection, session data, or UI.

## What one run covers

| Step | Proof |
|---|---|
| `regression-probe.ts both` | `callback` mode preserves the seq 1185 repro (negative WASM allocation pointer on Bun 1.3.14); `deferred` mode is clean |
| `test:native-live-parser-e2e` | DSR write-back exactly once, reconstruction == ground truth, bounded overflow, fault containment, tmux sentinel |
| pwsh 7 / Neovim targets | Live screen through a real ConPTY TUI; verdict includes reconstructed screen text |
| Claude / Codex targets | Same proof, metrics + SHA-256 only (fail-closed privacy: raw agent bytes never leave `raw\`) |

Each target verdict records: reconstruction match vs a fresh-core replay of the
ordered stream tap, parser health, query-reply count, drain latency
(p50/p95/max), and host memory — the practical budget numbers.

## Run (one command, from the repo root)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File src\bun\native-terminal-registry\__tests__\run-windows-live-matrix.ps1
```

Prerequisites: `bun install` done, Bun 1.3.14 on PATH; log into Claude/Codex
first; `pwsh`/`nvim` optional (recorded as skipped when absent). Useful
switches: `-SkipAgents`, `-SkipE2E`, `-Cols 100 -Rows 30`,
`-ClaudeCommand @("claude")`, `-CodexCommand @("codex")`, `-NvimCommand @("nvim")`.

**Paste back everything in `<outdir>\share`** (`environment.json`,
`results.json`, `regression-probe.txt`, `live-parser-e2e.txt`, per-target
`*.verdict.json` / `*.run.txt`). Keep `<outdir>\raw` local — agent session
state may hold real transcript bytes.

## Evidence record — macOS (harness validation)

> Executed 2026-07-22 on macOS (darwin arm64, Bun 1.3.14) while building the
> harness; the Windows run is the acceptance target and is recorded below.

| Target | Match | Health | Query replies | Drain p95 | Host RSS |
|---|---|---|---|---|---|
| bash | yes | live | 0 | 1 ms | — |
| nvim | yes | live | 2 (startup DSR answered live) | 1 ms | 128.6 MB |
| claude (metrics-only) | yes | live | 0 | 1 ms | 85.6 MB |

Regression probe on macOS: `callback` and `deferred` both clean (the failure is
Windows-specific). E2E: `ALL CHECKS PASSED` (32 checks).

## Evidence record — native Windows (STATE-005 acceptance)

> Status: **PENDING** — run the one-command matrix above on the Windows host
> and paste the `share` directory back; this section is then filled with the
> environment, per-target verdicts, latency/memory budgets, and the
> regression-probe callback/deferred outcome.
