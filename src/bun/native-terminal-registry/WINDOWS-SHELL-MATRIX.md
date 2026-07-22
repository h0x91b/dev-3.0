# Windows shell launch matrix (HOST-008 / WIN-003)

This proof is restricted to the isolated native-session registry. It does not
select a product terminal backend, add settings, change RPC/UI, or alter the
persisted project/task schema. The existing import-graph and PATH-sentinel tests
prove that production terminal flows and tmux remain untouched.

## Verdict matrix

| Target | Requirement | Executable selection | Native verdict |
|---|---|---|---|
| Windows PowerShell 5.1 | required | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | `SUPPORTED` only after every lifecycle check passes |
| PowerShell 7 | required | exact `Get-Command pwsh.exe` result | `SUPPORTED` only after every lifecycle check passes |
| cmd.exe | required | exact `%ComSpec%` path | `SUPPORTED` only after every lifecycle check passes |
| Git Bash | optional | known Git installation paths | `DETECTED / SKIPPED` or `NOT DETECTED / SKIPPED` |
| WSL | optional | `Get-Command wsl.exe` plus distro report | `DETECTED / SKIPPED` or `NOT DETECTED / SKIPPED` |

Every required row gates on the same checks: structured launch command, cwd,
Unicode environment, exact argv, root PID/version, retained state, same-PID
reattach, owned descendant teardown, exit code 37, and natural-exit cleanup.
The common gates distinguish `executable-not-found` from exit 37 and require the
tmux PATH sentinel to remain absent.

## Run on native Windows

Prerequisites: this repository with dependencies installed and Bun exactly
1.3.14 on PATH. PowerShell 7 is required; Git Bash and WSL are not.

```powershell
cd <repo>
powershell -NoProfile -ExecutionPolicy Bypass -File src\bun\native-terminal-registry\__tests__\run-windows-shell-matrix.ps1
```

Use `-OutDir C:\path\to\evidence` to select an output directory. The runner
writes the compact, shareable `share\windows-shell-verdict.json`, console output
to `windows-shell-matrix.txt`, and per-session diagnostics under `raw\`.

## CI and evidence status

The `Packaged Bun runtime` workflow runs the focused pure/isolation tests on all
three operating systems, then runs this PowerShell runner on `windows-latest`
with Bun 1.3.14 and uploads the evidence as `windows-shell-launch-matrix`. A Unix
run is not accepted as Windows evidence; macOS and Linux continue to run the
existing registry lifecycle test unchanged.

No native result is embedded in this document before it runs. The generated JSON
is the authoritative verdict and records the OS/architecture, Bun version, all
required checks, optional detection, exact exit verdicts, PIDs, and scope guards.
