# 173 — Platform launch dialect for generated wrapper scripts

## Context

dev3 drives every terminal it owns through generated wrapper scripts: the task
run wrapper, the setup/startup wrapper, the agent-not-found retry wrapper and the
cleanup script. All of them were POSIX shell text stitched together at the call
sites (`#!/bin/bash`, `export`, `printf '\033[...'`, `exec`, `read -n 1 -s`,
`command -v`). Windows has no shell that understands any of that, so the Windows
port needed the same call sites to render PowerShell.

## Decision

`src/shared/platform-launch.ts` holds a `LaunchDialect` — a small set of
structural primitives (`header`, `envLines`, `print`/`style`, `captureExitCode`,
`branchOnFailure`, `runScript`, `execReplacing`, `readKey`/`readLine`,
`ifCommandExists`, `scriptLaunch`) with two implementations: `posix-shell` and
`windows-powershell`. Call sites ask for structure, never for shell text.

- The wrapper builders live in `src/bun/rpc-handlers/shared-pure.ts`
  (`buildCmdScript`, `buildAgentRetryWrapper`, `buildSetupStartupWrapper`), the
  cleanup script in `src/bun/lifecycle/executor.ts`.
- Script names come from `dialect.scriptExtension`, so a task writes `run.sh` on
  POSIX and `run.ps1` on Windows into the same `dev3TaskTempPath` slots.
- A native primary terminal is launched with `dialect.scriptLaunch(...)`, i.e.
  `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File run.ps1` on
  Windows and `<login shell> run.sh` on POSIX. Shell discovery reuses
  `defaultNativeShellLaunchSpec` from the native-terminal registry rather than
  restating the `%SystemRoot%` layout — hence the extra sanctioned importer in
  `native-terminal-registry/__tests__/isolation.test.ts`.
- tmux is POSIX-only, so the tmux-shaped builders (dev-server session, package
  script panes, cleanup session, the tmux flavour of the setup wrapper) call
  `assertPosixLaunchDialect` and throw on Windows. No silent degradation between
  backends.

## Risks

- **POSIX regression** is the whole risk: a byte that moves changes what every
  existing macOS/Linux task terminal does on the next launch.
  `src/bun/__tests__/platform-launch-posix-golden.test.ts` pins the full rendered
  text of all wrappers against the pre-dialect output.
- The PowerShell flavour is unexecuted on POSIX CI. Agent command lines are still
  produced as POSIX-quoted strings elsewhere and are run through
  `Invoke-Expression`; simple forms (`claude 'task'`) parse in PowerShell, complex
  quoting will need a separate normalisation pass.

## Alternatives considered

- **Per-call-site `if (win32)` branches** — the four wrappers plus their nested
  blocks would each grow two spellings; the tmux/native split already lives there.
- **Translate POSIX text to PowerShell at write time** — a shell-to-shell
  translator is strictly harder than emitting the target dialect directly.
- **Require a POSIX shell on Windows (Git Bash/WSL)** — contradicts the managed
  appliance direction and adds a dependency the in-app updater cannot install.
