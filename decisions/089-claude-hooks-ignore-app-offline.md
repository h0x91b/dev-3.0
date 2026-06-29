# 089 — Claude Hooks Ignore App-Offline Exit Code

## Context

dev3-generated Claude Code hooks call `~/.dev3.0/bin/dev3 task move ...` from `.claude/settings.local.json` (`PreToolUse`, `UserPromptSubmit`, `PermissionRequest`, `Stop`). When the desktop app is closed — common during an app update or a crash — the CLI exits `CLI_EXIT_CODE_APP_NOT_RUNNING` (`2`) via `exitAppNotRunning()`. Claude Code interprets a hook exit code of `2` as a *blocking* error: it blocks the tool call, erases the prompt, or blocks stoppage. So a closed app wedged the agent on every Edit/Bash (see the reported `PreToolUse:Edit hook error: ... app not running`).

## Investigation

This is the Claude counterpart of [decision 032](032-codex-hooks-ignore-app-offline.md), which fixed the same collision for Codex. Codex hooks already wrapped their move commands with a selective fallback; Claude hooks (`buildClaudeHooks` / Claude branch of `buildStopGroups`) still emitted raw commands. The fix belongs in [src/shared/agent-hooks.ts](src/shared/agent-hooks.ts), not in the general CLI exit path — changing `exitAppNotRunning()` globally would make normal human CLI usage report success for a real failure.

## Decision

Generalized `wrapCodexAppOfflineFallback` → `wrapAppOfflineFallback` (`<cmd> || [ $? -eq 2 ]`) and applied it to every Claude move command. It collapses **only** exit code `2` into success; any other failure still propagates. The CLI still prints its "app not running" notice to stderr, so the warning survives (visible in Claude's transcript) — it just no longer blocks the agent. Codex `Stop` hooks keep their JSON-envelope wrapper unchanged.

## Risks

Relies on the CLI keeping `exitAppNotRunning()` on exit code `2`; if that code changes, the shell guard must move with it (the constant `CLI_EXIT_CODE_APP_NOT_RUNNING` is the single source). Shell-string based, so future hook-execution changes could require revisiting quoting.

## Alternatives considered

- Change `exitAppNotRunning()` to exit `0`: rejected — hides a real failure for normal CLI users and scripts.
- Append `|| true`: rejected — would swallow unrelated errors and mask real hook regressions.
- Map exit `2` → exit `1` (Claude's non-blocking error): rejected — surfaces a red warning on *every* tool call while the app is down, which is noisy for a persistent state.
