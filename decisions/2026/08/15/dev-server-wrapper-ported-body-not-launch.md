# Port the dev-server wrapper's BODY, and move the tmux refusal to the tmux session

## Context

On Windows the Dev Server button and `dev3 dev-server start` failed outright with
`the dev-server pane requires the tmux backend, which is POSIX-only — no Windows
equivalent exists` (reproduced by Arseny on Windows 10 Pro 22H2, dev3 v1.44.0,
native backend; issue #1387). Two separate things were wrong, and fixing either
alone is a trap:

1. `runDevServer` called `assertPosixLaunchDialect("the dev-server pane")` as its
   FIRST statement, so the native path never ran. The name was wrong too: the
   thing that needs tmux is the nested `dev3-dev-<id>` session plus the viewer
   pane that attaches to it, not the pane concept.
2. The wrapper it would have run was hand-written bash — `#!/bin/bash`, `set -x`,
   `[ $EXIT_CODE -ne 0 ]`, `read -n 1 -s` — launched with a hardcoded
   `nativeLaunch: { executable: "/bin/bash" }`.

Swapping only the launch (Seq 1544 deliberately did not) would have been worse
than the outage: PowerShell would half-run bash text and the pane would look like
it started.

## Investigation

A third defect was found on the way, in already-merged code. `auxPaneMarker`
re-finds an auxiliary pane by substring-matching its launch command, and the
suffixes carried file extensions (`dev.sh`, `col-agent.sh`). The dialect names a
generated script `.ps1` on Windows, so on Windows the column-agent pane (merged in
Seq 1544) launches and is then invisible to every later lookup — is it running,
replace it, stop it. `gitOp` was safe only by luck (`git-`, no extension).

## Decision

- The wrapper body moved into `src/bun/dev-server-script.ts`
  (`buildDevServerScript`), authored in the launch dialect. `runDevServer`
  (`src/bun/rpc-handlers/tmux-pty.ts`) now composes it structurally and launches
  it via `generatedScriptLaunch` / `generatedScriptName`.
- `assertPosixLaunchDialect` moved down to the nested-tmux branch and was renamed
  to `the nested dev-server tmux session`. A Windows task is always native
  (`newTaskTerminalBackend`), so that branch is unreachable there.
- `LaunchDialect` gained `traceOn()` / `traceOff()` (`set -x` / `Set-PSDebug`).
- `AUX_PANE_PURPOSES` suffixes lost their extensions (`dev`, `col-agent`), which
  also repairs the column-agent pane on Windows.

**POSIX moved by exactly three lines**, deliberately, and they are pinned in their
new form in `dev-server-script.test.ts`: `echo ""` + `echo "…$EXIT_CODE…"` became
one `printf '\n…%s…\n' "$EXIT_CODE"`, and `read -n 1 -s` became the dialect's
shell-portable read (identical under bash, which is what launches the file).
Reproducing the old spelling would have meant adding dialect members that
duplicate `print` and `readKey`, which this repo forbids; the sibling agent
wrapper has always printed its exit notice with `printf`.

## Risks

- **The user's own `devScript` is NOT ported and cannot be.** It is the user's
  text in the user's shell. `bun run dev` happens to be valid in both dialects;
  `VITE_PORT=${DEV3_PORT0:-5173} bun run dev` is a PowerShell parse error. What
  changes is that the failure is now the user's script failing in a live pane
  instead of dev3 refusing to open one. Documenting the platform caveat next to
  `devScript` is a separate, open product question.
- The dev-server teardown (`killDevServerSession`, `buildDevServerStatus`) reads
  process trees and port owners through `ps` and `lsof`. Those degrade to empty
  on Windows rather than throwing, so start/stop work, but port detection and
  descendant reaping are POSIX-only in practice. Out of scope here; unproven on
  Windows either way.

## Alternatives considered

- **Guard the whole feature on Windows with a nicer message.** Rejected: the
  wrapper is the only reason it could not run, and the button is the point.
- **Translate the user's `devScript` to PowerShell.** Rejected outright — dev3
  cannot know what the text means, and a half-translation is a silent wrong
  command against the user's repo.
- **Keep POSIX byte-identical by adding `echo`-shaped dialect members.** Rejected:
  two ways to print one line, for legacy spelling that renders the same
  characters.
