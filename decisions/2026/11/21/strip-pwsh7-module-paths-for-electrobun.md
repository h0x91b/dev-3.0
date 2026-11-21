# Strip PowerShell 7 module paths before running the electrobun CLI

## Context

"Windows proof (main)" went red on six post-merge runs on 2026-11-19 and 2026-11-21 (44527711202, 44527727439, 44527800382, 44528558714, 44875185576, 44875201105) while neighbouring runs were green. Every failing job died the same way inside `electrobun build`: `Expand-Archive` threw `Cannot find an overload for "ExtractToDirectory" and the argument count: "3"` from `C:\program files\powershell\7\Modules\Microsoft.PowerShell.Archive`, and electrobun then reported `Bun binary not found after extraction`.

## Investigation

The suspected cache/download race was wrong. Tabulating every Windows job of the last 40 runs by runner image: all 18 jobs on `win25-vs2026` `20261103.298.1` passed, all 10 on `20261116.315.1` failed. The "neighbouring green runs" were either on the old image or out of scope (windows-proof skipped), and Canary publish skipped its windows-proof too, so neither was evidence. The new image moved PowerShell 7.6.9 → 7.6.10, which ships `Microsoft.PowerShell.Archive` 1.2.7.

Mechanism: the build step runs in the default `pwsh` shell, which prepends its own module dirs to `PSModulePath`. electrobun's compiled CLI runs `powershell -command "Expand-Archive ..."` (Windows PowerShell 5.1), which inherits that value, finds PowerShell 7's Archive 1.2.7 first, and that module calls a .NET Core-only overload that .NET Framework lacks. A probe on 4 runners (run 44876356092, all on the new image) showed: inherited env → fails 4/4; same command with PowerShell 7 entries removed → extracts 4/4; from a `bash` step (no pwsh in the chain) → extracts 4/4; `Compress-Archive` the same way → works.

## Decision

`scripts/electrobun.ts` is now the only way to run the electrobun CLI: it removes PowerShell 7 module dirs (`$PSHOME\Modules` found by the `pwsh.exe` beside it, plus `Documents\PowerShell\Modules` and `Program Files\PowerShell\Modules`) from `PSModulePath` on Windows, logs what it dropped, and runs `node_modules/electrobun/bin/electrobun.cjs` with the remaining args. Package scripts, all three release builds and the tracer step call it; `scripts/dev.ts` applies the same scrub in-process (`scripts/windows-powershell-env.ts`). `src/bun/__tests__/windows-powershell-env.test.ts` fails on any bare `electrobun build`/`bunx electrobun`/`electrobun.cjs` in package.json or a workflow. The fix also covers developers building from a PowerShell 7 terminal, and the release workflow, whose `Build release` step runs under the same default `pwsh`.

## Risks

The match is by directory shape, so a pwsh installed somewhere without `pwsh.exe` next to its `Modules` would be missed; the log line then shows nothing dropped. It strips paths only for the electrobun process tree, never for the shipped app. If electrobun stops calling Windows PowerShell 5.1, this becomes a harmless no-op and can be deleted.

## Alternatives considered

- Scrub the env inside `electrobun.config.ts` (the CLI imports it in-process): one seam, but the app bundles that file too, so it would rewrite `PSModulePath` for every terminal the running app spawns.
- `shell: bash` on the workflow steps: fixes CI only, and leaves anyone building from pwsh 7 broken.
- Pre-seed the Bun override ourselves so electrobun never extracts: more code, and still leaves the CLI's PowerShell calls exposed to the same env.
- A retry: the failure is deterministic on the new image, so a retry only helps when the job lands on an old runner — it would hide the cause until the old image is gone and then fail every time.
