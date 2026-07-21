# Windows shell & agent replay matrix (STATE-004)

Closes the remaining native-Windows capture/replay matrix for the terminal-state
spike: **cmd.exe**, **PowerShell 7 (pwsh)**, **Claude**, and **Codex**.
PowerShell 5.1 and macOS Neovim are already proven (see `README.md`).

This is disposable spike tooling. Nothing here is imported by production; it does
not touch tmux, backend selection, session data, or visible UI.

## What it proves

| Target | Kind | Proof |
|---|---|---|
| cmd.exe | shell | Deterministic ConPTY frame → fresh-core replay roundtrip |
| pwsh 7 | shell | Deterministic UTF-8 frame (real glyphs, no 5.1 mojibake) → replay roundtrip |
| Claude | agent | Startup, query handling, resize, scripted I/O, detach boundary, fresh replay, exit |
| Codex | agent | Same agent proof set as Claude |

The capture path stays decoupled from Ghostty on Windows because Bun 1.3.14
returns a negative WASM allocation pointer when Ghostty runs inside a Bun.Terminal
data callback (decision 146). Startup terminal queries are answered by a static,
non-Ghostty responder (`terminal-query-responder.ts`); replay and the semantic
comparison run offline through a real Ghostty core (`verify-journal.ts`).

## Evidence & privacy policy (fail-closed)

- **Shells** (cmd, pwsh) emit fixed, non-sensitive probe output. They are stored
  as a sanitized journal **only when a secret/path/PII scan is clean**; any hit
  downgrades them to metrics-only.
- **Agents** (Claude, Codex) **never** store raw transcript bytes. They are always
  reduced to a SHA-256 hash plus structural metrics, which still proves startup,
  query handling, resize, detach, and exit.
- Absolute paths in provenance are redacted. The scripted agent interaction is
  content-free (a benign keystroke, a resize, then quit) — no real prompt is
  submitted, so no credentials, repository data, or model output is exercised.
- Raw journals stay in `<outdir>\raw` and must not be shared. Only `<outdir>\share`
  leaves the machine.

## Prerequisites

- `bun` on `PATH` (required).
- Log into Claude and Codex first so their interactive TUIs actually start.
- `pwsh` (PowerShell 7) optional — if absent it is recorded as unavailable.

## Run (one command, from PowerShell)

Runs under Windows PowerShell 5.1 (`powershell`) or PowerShell 7 (`pwsh`):

```powershell
cd <repo>
powershell -NoProfile -ExecutionPolicy Bypass -File src\bun\prototypes\terminal-state\run-windows-matrix.ps1
```

Useful switches: `-SkipAgents`, `-SkipSuite`, `-Cols 100 -Rows 30`,
`-ClaudeCommand @("claude")`, `-CodexCommand @("codex")`.

PowerShell 7 (`pwsh`) is itself a capture target. If it is not installed the
matrix records it as a documented gap; to capture it, install it first with
`winget install --id Microsoft.PowerShell` (or `choco install powershell-core`).

The script prints a summary table and two paths: the **share** directory (paste
its contents back) and the **raw** directory (keep local).

## Manual per-target commands (fallback)

```powershell
# 1) capture a scripted live session → raw journal
bun src\bun\prototypes\terminal-state\capture-session.ts <spec.json> <raw\target.journal.json>
# 2) offline replay roundtrip verdict (+ optional shell fixture)
bun src\bun\prototypes\terminal-state\verify-journal.ts <raw\target.journal.json> [name fixtures\name.json]
# 3) sanitize into shareable artifacts
bun src\bun\prototypes\terminal-state\sanitize-cli.ts <raw\target.journal.json> <share>
# 4) spike suite + benchmark
bun run test:terminal-state-spike
bun run benchmark:terminal-state-spike
```

## What to paste back

Everything in `<outdir>\share`:
`environment.json`, `results.json`, `suite.txt`, `benchmark.txt`, and per-target
`*.metrics.json`, `*.verdict.json`, plus `*.sanitized-journal.json` for clean
shells. Do **not** paste anything from `<outdir>\raw`.

## Promoting shell captures to golden fixtures (phase 2)

For clean shell captures, `verify-journal.ts <journal> <name> fixtures/<name>.json`
writes a harness fixture. Add its name to the fixture arrays in
`__tests__/terminal-state.test.ts` and `__tests__/renderer-replay.test.ts`, with
golden assertions mirroring `real-powershell`. Agent journals are refused here so
raw bytes never enter a stored fixture.

---

## Evidence record

> Status: **PENDING native Windows run.** Filled from `share/` artifacts after the
> matrix is executed on the target host. Failures are recorded as production gaps,
> not normalized away.

### Environment

| Field | Value |
|---|---|
| Windows caption / version / build | _pending_ |
| Architecture | _pending_ |
| Bun / Node | _pending_ |
| cmd (`ver`) | _pending_ |
| PowerShell 5.1 / pwsh 7 | _pending_ |
| Claude / Codex versions | _pending_ |

### Results

| Target | Captured | Match @detach | Match after replay | Exit | Mode | Notes / gaps |
|---|---|---|---|---|---|---|
| cmd.exe | _pending_ | _pending_ | _pending_ | _pending_ | fixture | |
| pwsh 7 | _pending_ | _pending_ | _pending_ | _pending_ | fixture | |
| Claude | _pending_ | _pending_ | _pending_ | _pending_ | metrics | |
| Codex | _pending_ | _pending_ | _pending_ | _pending_ | metrics | |

### Capability coverage (from `*.verdict.json`)

| Target | cursor | modes | wrapping | unicode | colors | alt-screen | final dims |
|---|---|---|---|---|---|---|---|
| cmd.exe | _pending_ | | | | | | |
| pwsh 7 | _pending_ | | | | | | |
| Claude | _pending_ | | | | | | |
| Codex | _pending_ | | | | | | |

### Production gaps observed

- _pending native run_
