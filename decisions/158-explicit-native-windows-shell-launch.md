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
The [PowerShell install documentation](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows)
states that WinGet defaults to MSIX starting with 7.6. Native evidence showed
that carrier activates the root shell outside the host's Job Object
(`host=true`, `shell=false`, `child=false`), while cmd consumes doubled embedded
quotes before child argv parsing.

## Decision

The [`shell-launch.ts` functions](../src/bun/native-terminal-registry/shell-launch.ts)
`defineShellLaunchSpec`, `encodeShellLaunchSpec`, and `decodeShellLaunchSpec`
own `{ executable, argv, cwd, env }` across host re-entry. `resolveShellLaunchSpec`
resolves only the requested executable, while `windowsShellLaunchSpec` rejects
unknown shell kinds and `shellExitVerdict` retains the exact numeric exit code.
The Windows runner honors an explicit `-PwshPath` without fallback, otherwise
prefers `%ProgramFiles%\PowerShell\7\pwsh.exe` before a PATH entry, and rejects
WindowsApps executables with an actionable MSI/ZIP verdict. The cmd probe uses
balanced quoted segments around caret-escaped literal quotes.
The exact native Windows result is preserved in
[`windows-shell-verdict-72e2ddcb.json`](../src/bun/native-terminal-registry/__tests__/windows-shell-verdict-72e2ddcb.json)
and validated as part of the focused pure suite.

## Risks

cmd and PowerShell have different interactive quoting rules, so the native
matrix keeps exact metacharacter and quote probes rather than assuming parity.
Windows Job termination can become observable one process at a time, so the
matrix verifies direct membership and polls the three known PIDs to a bounded deadline.
PowerShell 7.6 WinGet installs MSIX by default, so machines with only that carrier
must install the MSI build or use an unpackaged ZIP executable for this proof.
The descriptor is registry-local and is not a product backend seam; future
integration still needs an explicit architecture decision.

## Alternatives considered

Keeping `cmd: string[]` plus separate cwd/environment variables was rejected
because host re-entry could not validate one atomic launch request. Falling back
from a missing requested shell to another installed shell was rejected because
it would turn support gaps into misleading successes.
Assigning the activated Store process after spawn was rejected because it
reintroduces a child-creation race and the
[`AssignProcessToJobObject` contract](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
does not guarantee assignment when the process already belongs to an unrelated
Job Object hierarchy.
