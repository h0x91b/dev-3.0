# 023 — Codex Uses Worktree-Local Hooks for dev3 Task Lifecycle

## Context

Codex already had dev3-specific sandbox and permission profile setup, but task status transitions still depended on the generic SKILL instructions. That was weaker than the Claude path and made automatic AI review unreliable for Codex tasks.

## Investigation

Codex hooks can run from repo-local `.codex/hooks.json`, but only when `[features] codex_hooks = true` is enabled in `~/.codex/config.toml`. Codex does not expose a `PermissionRequest` hook, so exact Claude parity is impossible for the "waiting for approval" transition.

## Decision

dev3 now writes worktree-local Codex hooks from [src/shared/agent-hooks.ts](src/shared/agent-hooks.ts) and installs them during task launch via [src/bun/agent-hooks.ts](src/bun/agent-hooks.ts). The lifecycle uses `SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher `Bash`), and `Stop`; `user-questions` stays an explicit fallback instruction in [src/bun/agent-skills.ts](src/bun/agent-skills.ts) and the Codex launch prompt in [src/bun/agents.ts](src/bun/agents.ts).

## Risks

Codex reads `config.toml` at startup, so existing sessions will not see new hooks until restart. The `Stop` dual-hook review path still depends on concurrent matching hook execution, although Codex documents that behavior today.

## Alternatives considered

- Keep Codex on manual status management only: rejected because it leaves Codex behind Claude and keeps auto-review inconsistent.
- Emulate `PermissionRequest` with a heuristic script: rejected for now because parsing assistant text to infer blocked approvals would be brittle and hard to trust.
