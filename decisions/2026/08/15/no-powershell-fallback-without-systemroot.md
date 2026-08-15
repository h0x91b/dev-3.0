# No PowerShell PATH fallback when %SystemRoot% is absent

## Context

`powerShellPath()` (`src/shared/platform-launch.ts`) and `paneRunShell()` (`src/bun/pane-run-store.ts`)
both resolve Windows PowerShell 5.1 under `%SystemRoot%` and throw when it is absent, while their
sibling `defaultLaunchShellPath()` catches the same failure and degrades to `powershell.exe` on PATH.
Seq 1548 was asked to remove that inconsistency by making the two throwing call sites degrade too.

## Investigation

Reachability first: both read the app's OWN `process.env` (no argument is passed), and Windows sets
`SystemRoot` for every normal desktop process — so neither is reachable by an ordinary launch.

The fallback was then written, and executed on `windows-latest` with `SystemRoot`, `SYSTEMROOT` and
`WINDIR` deleted from the environment (run 31877226362). The lookup degraded exactly as intended —
and the launch it produced was worthless:

```
Internal Windows PowerShell error.  Loading managed Windows PowerShell failed with error 8009001d.
```

`powershell.exe` is found on PATH and starts, but PowerShell 5.1 loads its managed runtime out of
`%SystemRoot%` and cannot initialise without it. It printed nothing and **exited 0** — a silent
success wearing the shape of a finished build. A control run in the same job, with the variable
present, ran the identical generated script to completion and exited 5, so the script and the launch
spec were never in question.

The pane run in the same environment went further than that: the child `bun` process produced no
output, wrote no status file and exited non-zero before any dev3 code ran. `%SystemRoot%` is missing
for our own runtime too, so in that environment nothing dev3 decides at the lookup is even reachable.
`paneRunShell`'s refusal is therefore covered by its unit test; the dialect's refusal, which IS
reached in-process, is what the Windows step asserts.

## Decision

**The two launch-time call sites keep throwing, and the reason is now written next to them.** A
fallback here converts a named refusal (`SystemRoot is required …`) into a run that dies with error
8009001d and reports exit 0 — strictly worse for the agent reading that outcome.

`defaultLaunchShellPath()` keeps its degradation: it runs during boot (`getUserShell`), where dying
is worse than returning a shell that may not start.

The evidence is not prose — `src/cli/__tests__/pane-run-exec.bun-e2e.ts` launches the rejected
fallback for real on every Windows CI run and asserts it produces nothing, so the day PowerShell
stops needing `%SystemRoot%`, that step says so.

## Risks

The e2e depends on a failure mode of Windows PowerShell 5.1. If a future Windows makes the fallback
viable, the "produces nothing" check fails and this record must be revisited — which is the intended
alarm, not a flake.

## Alternatives considered

- **Degrade to `powershell.exe` on PATH** — implemented, executed, rejected on the evidence above.
- **Default `%SystemRoot%` to `C:\Windows`** (what `staged-host-runtime.ts` does for its own shell)
  — does not help: the child inherits the same stripped environment, and it is the environment, not
  the executable path, that PowerShell fails on.
- **Inject `SystemRoot` into the child environment** — would work, but it is environment repair for
  a case no normal launch reaches, at the cost of dev3 inventing a system path.
