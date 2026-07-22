# 158 — Explicit native Windows shell launch descriptors

## Context

HOST-008 and WIN-003 need one registry-local launch model for Windows PowerShell
5.1, PowerShell 7, and cmd.exe without changing production terminal selection.
The registry previously passed a command array while cwd and environment used
separate host variables, and malformed command JSON silently chose a default.

## Investigation

`Bun.spawn` already accepts argv, cwd, and environment separately, so an
intermediate shell command string is unnecessary. The documented
[PowerShell `-NoExit`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)
and [cmd interactive mode](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd)
keep the root process alive; a separate attached probe tests shell-specific
argument quoting after launch instead of smuggling a command through argv.
Native evidence also showed that `Get-Command pwsh.exe` may return a WindowsApps
execution alias and that cmd consumes doubled embedded quotes before child argv parsing.

## Decision

The [`shell-launch.ts` functions](../src/bun/native-terminal-registry/shell-launch.ts)
`defineShellLaunchSpec`, `encodeShellLaunchSpec`, and `decodeShellLaunchSpec`
own `{ executable, argv, cwd, env }` across host re-entry. `resolveShellLaunchSpec`
resolves only the requested executable, while `windowsShellLaunchSpec` rejects
unknown shell kinds and `shellExitVerdict` retains the exact numeric exit code.
The Windows runner resolves the selected pwsh process's physical path, and the
cmd probe uses balanced quoted segments around caret-escaped literal quotes.

## Risks

cmd and PowerShell have different interactive quoting rules, so the native
matrix keeps exact metacharacter and quote probes rather than assuming parity.
The descriptor is registry-local and is not a product backend seam; future
integration still needs an explicit architecture decision.

## Alternatives considered

Keeping `cmd: string[]` plus separate cwd/environment variables was rejected
because host re-entry could not validate one atomic launch request. Falling back
from a missing requested shell to another installed shell was rejected because
it would turn support gaps into misleading successes.
