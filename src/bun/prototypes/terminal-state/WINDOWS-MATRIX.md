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

> Status: **DONE.** Executed on a native Windows host on 2026-07-22. All four
> targets captured and passed the detach-boundary replay roundtrip; the spike
> suite passed on Windows. Shell captures `real-cmd` / `real-pwsh7` are committed
> as golden fixtures (byte-identical to the Windows capture, verified by SHA-256).
> Agent captures are metrics-only by policy. Failures are recorded as production
> gaps below, not normalized away.

### Environment

| Field | Value |
|---|---|
| Windows caption / version / build | Windows 10 Pro / 10.0.19045 / 19045 |
| Architecture | AMD64 (x86_64) |
| Bun / Node | 1.3.14 / v24.18.0 |
| cmd (`ver`) | Microsoft Windows [Version 10.0.19045.6456] |
| PowerShell 5.1 / pwsh 7 | 5.1.19041.6456 / PowerShell 7.6.3 |
| Claude / Codex versions | 2.1.42 (Claude Code) / codex-cli 0.144.6 |

### Results

| Target | Captured | Match @detach | Match after replay | Exit | Mode | Bytes / SHA-256 (prefix) |
|---|---|---|---|---|---|---|
| cmd.exe | yes | yes | yes | 0 | fixture | 480 / `5aff0397` |
| pwsh 7 | yes | yes | yes | 0 | fixture | 1243 / `96206580` |
| Claude | yes | yes | yes | killed (null) | metrics | 4387 / `a87eebbb` |
| Codex | yes | yes | yes | 0 | metrics | 1531 / `0c97750e` |

Spike suite on Windows: **42 passed** (before the two new golden fixtures were
added). With `real-cmd` + `real-pwsh7` the suite is **46 passed** on macOS, and
those fixtures are deterministic byte-for-byte replays of the Windows captures.

### Capability coverage (from `*.verdict.json`)

| Target | cursor | modes | wrapping | unicode | colors | alt-screen | final dims |
|---|---|---|---|---|---|---|---|
| cmd.exe | yes | wraparound | no | no | yes | no | 100×30 |
| pwsh 7 | yes | wraparound | no | yes | yes | no | 100×30 |
| Claude | yes | bracketedPaste, focusEvents, wraparound | no | yes | yes | no | 120×40 |
| Codex | yes | wraparound | no | no | yes | no | 120×40 |

Claude and Codex exercised a real resize (100×30 → 120×40) plus a detach boundary
and post-detach events; both replays matched at the boundary and after it.

### Production gaps observed

- **Claude clean exit unproven.** Claude did not quit on the scripted `Esc` +
  `Ctrl+C` sequence within the grace window; it was killed (exitCode null). A
  production teardown must send Claude's real quit affordance, not `Ctrl+C`.
- **Query-handling is agent-specific.** Codex issued 2 startup queries (both
  `OSC-color`, both answered by the static responder); Claude issued no queries
  the responder recognizes (0 replies). A production responder needs per-agent
  probe coverage, not a fixed set.
- **Agents are metrics-only.** By the fail-closed privacy policy, Claude and
  Codex are proven via SHA-256 + structural metrics, not stored transcripts;
  their provenance contained a `windows-user-path` (redacted, as expected).
- **conhost cursor visibility.** cmd's `?25l` (hide) was not retained in the
  final ConPTY frame (cursor visible=true), though the bar cursor style survived.
- **Journal is unbounded** (see `README.md`); a production seam still needs a
  bounded Ghostty-native snapshot before this can leave the prototype.
- **Codex CLI aliasing.** winget's `OpenAI.Codex` did not create a `codex` shim
  on PATH for the running shell; the matrix was pointed at the package exe via
  `-CodexCommand`. Not a spike defect, but a setup gap worth noting.
