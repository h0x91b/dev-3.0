# Gitless Claude tasks get their hooks through `--settings`

## Context

A project with its git workflow off runs every task in the user's own folder (`decisions/2026/10/02/per-project-git-workflow-switch.md`). dev3 merged its Claude status hooks, its `Bash(dev3:*)` rules and the launch's `defaultMode` into that folder's `.claude/settings.local.json`. They stayed there after the task ended. The hooks needed a POSIX env guard to stay silent in a `claude` session the user started, Windows had no guard, and the permission rules stayed active.

## Investigation

Checked against Claude Code 2.1.289:

- Hooks in a `--settings` file fire, and a PreToolUse `permissionDecision: "deny"` from one blocks the edit.
- With two `--settings` flags only the last one applies, so the managed file dev3 already passes (statusline, `skipDangerousModePermissionPrompt`) has to be merged, not added.
- Claude relaunches agent-team teammates with the lead's `--settings <path>`, so teammates get the same hooks and mode.
- Claude rewrites `settings.local.json` from its own snapshot; it never rewrites a `--settings` file.

## Decision

In a folder dev3 does not own (`isDev3OwnedFolder`), `setupAgentHooks` (`src/bun/agent-hooks.ts`) writes `writeClaudeFlagSettings` (`src/shared/agent-hooks.ts`): the managed settings plus hooks, Bash rules and `defaultMode`, at `<dev3 home>/data/agent-hooks/claude-folder-settings-<hash>.json`. `applyAgentHooksToCommand` (`src/bun/rpc-handlers/tmux-pty.ts`) swaps it for the managed file in the command. The name is a content hash, so a running session's file never changes under it. The hooks carry no env guard because only a dev3 launch loads the file. `refreshClaudeHooksForTask` skips these folders, and Codex no longer gets a `.codex/hooks.json` there, because its live hooks come from `config.toml`.

Worktrees keep `settings.local.json`: a `claude` the user starts by hand in a worktree should still move its task.

## Risks

- If the command carries no managed `--settings` (the user passes their own in additional args, or the agent-check wrapper replaced the command), dev3 falls back to the guarded folder write.
- A future Claude that stops forwarding `--settings` to teammates would leave teammates without hooks and mode. Their status moves would stop, but the lead would still move the task.

## Alternatives considered

- Removing dev3's entries from the folder when the last task leaves: needs reference counting across tasks and fails whenever the app is down at that moment.
- A second `--settings` flag: Claude keeps only the last one.
