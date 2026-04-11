# 032 — Codex Hooks Ignore App-Offline Exit Code

## Context

dev3-generated Codex hooks call `~/.dev3.0/bin/dev3 task move ...` from repo-local `.codex/hooks.json`. When the desktop app is closed, the CLI exits with code `2` via `exitAppNotRunning()`, and Codex interprets that hook failure as an intentional block for prompt submission and tool execution.

## Investigation

Changing `exitAppNotRunning()` globally would make normal human CLI usage report success for a real failure, which is the wrong contract outside hooks. The bug is specific to generated Codex hook commands, so the fix needs to live in [src/shared/agent-hooks.ts](src/shared/agent-hooks.ts), not in the general CLI exit path in [src/cli/output.ts](src/cli/output.ts).

## Decision

Codex `SessionStart`, `UserPromptSubmit`, and `PreToolUse` hooks now wrap `dev3 task move` with a shell fallback that only treats exit code `2` as success. The `Stop` hook keeps returning `{}` JSON, but now does so both on normal success and on the same app-offline exit code while still re-throwing any other failure status.

## Risks

This relies on the CLI keeping `exitAppNotRunning()` on exit code `2`; if that code changes, the shell guard must be updated with it. The workaround is shell-string based, so future Codex hook execution changes could require revisiting quoting or exit-code handling.

## Alternatives considered

- Change `exitAppNotRunning()` to exit `0`: rejected because it would hide a real failure for normal CLI users and scripts.
- Append `|| true` to generated Codex hooks: rejected because it would swallow unrelated errors and could mask real hook regressions.
