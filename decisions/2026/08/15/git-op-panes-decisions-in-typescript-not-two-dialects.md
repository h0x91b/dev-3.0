# Git-op pane scripts: the decisions move to TypeScript, only the commands stay in the shell

## Context

The Rebase, Push and Merge panes built `#!/bin/bash` text inline in `src/bun/rpc-handlers/git-operations.ts` and launched it with `nativeLaunch: { executable: "/bin/bash", ... }`. On Windows that shell does not exist, so the panes were dead. Seq 1544 fixed the LAUNCH for the agent panes ([aux-pane-script-launch-through-the-dialect](../14/aux-pane-script-launch-through-the-dialect.md)) and deliberately left these alone: swapping only the launch would feed bash text to PowerShell, which is worse than failing because it looks like it ran.

## Investigation

The bash originals carried two different things. Most lines were commands (`git rebase`, `git push`). But the merge script also carried a DECISION — an `if`/`elif`/`else` over two `git rev-parse --verify` calls, choosing between `git checkout`, `git checkout --track -b`, and an error. Re-spelling that decision in PowerShell would mean one rule expressed twice, in two dialects that can drift apart, each tested only on its own platform.

Three Windows-only failure modes showed up while porting. They share one MECHANISM, and it is the mechanism that matters, not the three lines that fix it: **on Windows a step can complete, print nothing alarming, and set a value dev3 then reads as success — while having delivered nothing.** The verdict is a number in a file, the exit code is an ambient variable, and the prompt is a console call; each of the three is a place where the *carrier* of the answer, not the answer, is what differs between the dialects. A POSIX run exercises the identical code and sees none of it.

- **The verdict's encoding.** `$EC > file` in Windows PowerShell 5.1 is `Out-File`, which writes **UTF-16LE with a byte-order mark** — measured on windows-latest, the file holding `0` is literally `ff fe 30 00 0d 00 0a 00` (run `31875521911`). *The CONSEQUENCE is where the first draft of this record was wrong:* the earlier mutation run (`31874749711`) passed every decoded check, because Bun's text decoder handles the BOM and `monitorGitPane` would in fact have read `0`. The redirection is still wrong, for a smaller and truer reason: dev3 would be depending on an undocumented decoder behaviour to learn whether a push succeeded. The E2E now asserts the file's **bytes**, not its decoded text, and prints that hexdump on failure — which is the only reason the mechanism above is a measurement rather than a plausible story.
- **The exit code's provenance.** If a native command cannot be LAUNCHED (`git` not on PATH), PowerShell raises `CommandNotFoundException` and leaves `$LASTEXITCODE` at the *previous* command's value — a stale `0` reports a push that never happened as successful.
- **The prompt's channel.** `$Host.UI.RawUI.ReadKey` and `[Console]::KeyAvailable` **throw** when console input is redirected, which is every non-interactive run.

## Decision

**The port is not a translation.** Every decision moved into TypeScript (`git.getCurrentBranch`, `git.refExists` in `mergeTask`), tested once for every platform; what reaches the shell is a linear list of announced commands. `src/bun/git-op-script.ts` owns the shape (`buildGitOpScript`, plus `rebaseGitOpSpec` / `pushGitOpSpec` / `mergeGitOpSpec` so the E2E runs the text the app ships), and the dialect only has to spell "run this argv, capture the code, branch on it".

Four members joined `LaunchDialect` (`src/shared/platform-launch.ts`): `runCommand`, `describeCommand`, `sleepSeconds`, `writeExitCodeFile`, `exitWith`. `writeExitCodeFile` exists precisely so `>` can never be used for the verdict; `runCommand` clears `$LASTEXITCODE` before the call; the Windows `readKey` now branches on `[Console]::IsInputRedirected`. POSIX rendering is unchanged and `platform-launch-posix-golden.test.ts` still passes.

Two smaller consequences. The merge commit message travels as `git commit -F <file>` rather than `-m '<title>'`, because PowerShell 5.1's native-argument quoting mangles embedded double quotes — and the file is written with `Bun.write`, not `writeLaunchScript`, whose Windows byte-order mark would become the first bytes of the commit subject. And `gitOpPaths()` is the single place naming both the script and its `.exit` sibling; `monitorGitPane` used to rebuild `git-<op>.sh.exit` by hand, which stops matching the moment the script is not bash.

`openPullRequest` is NOT ported, and **on Windows it remains unavailable after this change**. Its prelude is `github.getGitHubShellExports()` — a `gh auth token` subshell, `[ -z ]`, `export`, `unset` — which lives in `src/bun/github.ts`. Porting it needs roughly six more dialect members (capture a command's stdout into a variable, test a variable for emptiness, export from a variable, clear a variable, read an ambient env var, fail the script), which is a rewrite of that helper rather than a git-op body port. On Windows `openPullRequest` now throws a clear error before any pane opens, instead of handing bash text to PowerShell and opening a pane that prints parse errors, opens no PR, and writes no verdict. Rejected alternative: resolve the token in TypeScript and pass it into the pane's environment — the runtime resolution exists precisely so the token never lands in a pane's environment.

## Two claims this record makes only because a mutation run tested them

Both mutations were run on windows-latest against the real branch, one hardcode each.

| Mutation | Run | What it proved |
|---|---|---|
| Restore `nativeLaunch: { executable: "/bin/bash" }` in `openGitOpPane` | `31874748311` | **A gap, not a pass.** All 18 E2E checks stayed green: the E2E calls `generatedScriptLaunch` itself, so it proves the SCRIPT and never the LAUNCH. `rpc-handlers/__tests__/git-op-pane-launch.test.ts` was added for exactly that. |
| Restore the `>` redirection for the verdict file | `31874749711` | The pure test caught it; the E2E did not, because Bun decodes the UTF-16LE BOM. The byte-level assertion above closes that. |

Re-run after both gaps were closed: `31875520414` (bash hardcode) and `31875521911` (redirection) each go **red** on windows-latest, and the clean branch (`31875519217`) stays green. Neither hole was visible before the mutation runs — the proof asserted things that were true and did not assert the two things that were load-bearing.

## Risks

- `[System.IO.File]::WriteAllText` resolves a relative path against .NET's working directory, not PowerShell's. Every caller passes an absolute `dev3TaskTempPath`, but a future relative path would write somewhere surprising.
- The failure path still ends in "press any key" and then closes the pane, the same as before. The user keeps the repository mid-rebase, with git's own conflict message on screen — that is the observed behaviour on both platforms, not just the intended one.
- Moving "base branch does not exist" from an in-pane message to a thrown RPC error changes where the user sees it (a UI error rather than a pane that opens only to say it can do nothing). Deliberate.

## Alternatives considered

- Re-spell the merge script's `if`/`elif`/`else` in PowerShell: rejected, that is the drift this record exists to prevent.
- `Set-Content -Encoding ASCII` for the verdict: works, but goes through the PowerShell provider stack and honours `$PSDefaultParameterValues`; the .NET call cannot be reconfigured out from under us.
- Pass the GitHub token into the openPR pane's environment instead of resolving it inside the pane: rejected — the runtime resolution exists so the token never lands in a pane's environment.
