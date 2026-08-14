# Auxiliary-pane wrapper scripts launch through the dialect, and POSIX keeps `/bin/bash`

## Context

Adding a second agent to a task on Windows died with `Failed to spawn agent: splitView failed: requested shell executable not found: /bin/bash` (Seq 1544, reported from a real Windows machine). The launch dialect (`src/shared/platform-launch.ts`) already renders wrapper scripts per platform, and the primary task launch already used `scriptLaunch`, but four auxiliary-pane call sites still passed `nativeLaunch: { executable: "/bin/bash", argv: [scriptPath] }` and named their script `*.sh`.

## Investigation

The script *bodies* of three of those sites are already dialect-rendered (`buildCmdScript` → `launchDialect()`), so only the launch and the file extension were POSIX-only. Two other sites — `runDevServer` and `openGitOpPane` — build their bodies as hand-written `#!/bin/bash` text; fixing their launch alone would feed a bash script to PowerShell, which is worse than the current clear error.

## Decision

`generatedScriptLaunch()` / `generatedScriptName()` in `src/bun/rpc-handlers/shared-pure.ts` are now the single place that answers "how is a generated wrapper handed to a native pane". They delegate to `launchDialect().scriptLaunch()`, and on POSIX they pass an explicit `/bin/bash` so the result stays byte-identical to the previous literal — the wrapper bodies are bash text, and switching them to the login shell would be a separate, unrelated behaviour change. Used by `spawnAgentInTask`, `launchColumnAgent` and `spawnSingleBugHunterPane` (`src/bun/rpc-handlers/tmux-pty.ts`).

The failure hint is chosen from the error text via `classifyLaunchFailure()` (`src/shared/launch-failure.ts`), sharing one marker constant with `ShellExecutableNotFoundError` so the thrower and the renderer cannot drift.

## Risks

The POSIX `/bin/bash` literal still exists, now in one documented place instead of five; a future move to the login shell has to be a deliberate change. The hint classification matches an error substring, which is why the marker is a shared constant with a test that constructs the real error.

## Alternatives considered

- Resolve the shell with `getLaunchShellPath()` (no explicit path): would silently switch macOS/Linux aux panes from bash to the user's login shell — rejected as an unrequested behaviour change.
- Add a structured error code across RPC for the hint: more churn than one shared marker string for a two-branch decision; revisit if a third hint appears.
- Also port `runDevServer` / `openGitOpPane` here: their script bodies are hand-written bash, so they need a body port, not a launch swap. Left as a separate defect.
