# Agent Support Matrix

Feature compatibility across supported AI coding agents.

Last updated: 2026-03-09

## Agents

| Agent | CLI binary | Skill directory |
|-------|-----------|-----------------|
| Claude Code | `claude` | `~/.claude/skills/dev3/` |
| Cursor Agent | `agent` | `~/.cursor/skills/dev3/` |
| Codex | `codex` | `~/.codex/skills/dev3/` |
| Gemini CLI | `gemini` | `~/.gemini/skills/dev3/` |
| OpenCode | — | `~/.opencode/skills/dev3/` |

## Feature Matrix

| Feature | Claude Code | Cursor Agent | Codex | Gemini CLI |
|---------|:-----------:|:------------:|:-----:|:----------:|
| **Skill injection** | Yes (`!` command syntax) | Yes (generic) | Yes (generic) | Yes (generic) |
| **System prompt injection** | `--append-system-prompt` | via prompt arg | — | — |
| **Session resume** | `--continue` | `--continue` | `resume --last` | `--resume latest` |
| **Permission mode** | `--permission-mode` | `--mode plan` / `--force` | `--permission-mode` | `--permission-mode` |
| **Effort level** | `--effort` | — | `--effort` | `--effort` |
| **Max budget** | `--max-budget-usd` | — | `--max-budget-usd` | `--max-budget-usd` |
| **Model selection** | `--model` | `--model` | `--model` | `--model` |
| **Auto-trust worktree** | Yes (`ensureClaudeTrust`) | — | — | — |
| **Status hooks (automatic)** | Yes (4 hooks) | — | — | — |
| **Status management** | Automatic via hooks | Manual (SKILL.md) | Manual (SKILL.md) | Manual (SKILL.md) |

## Status Hooks (Claude Code only)

Injected into `.claude/settings.local.json` per-worktree at task launch.

| Hook event | Status transition | Purpose |
|------------|------------------|---------|
| `UserPromptSubmit` | → `in-progress` | User sent a message, agent starts working |
| `PreToolUse` | → `in-progress` | Agent is about to call a tool (also catches post-permission resume) |
| `PermissionRequest` | → `user-questions` | Agent needs user approval for a tool call |
| `Stop` | → `review-by-user` | Agent finished its turn |

## Skill Differences

The dev3 skill (`SKILL.md`) is installed into each agent's skill directory. Two variants exist:

- **Claude variant** — simplified status section (hooks handle transitions automatically), uses `!` command injection for zero-tool-call startup
- **Generic variant** — full manual status management instructions ("CRITICAL — NON-NEGOTIABLE"), requires agents to run `dev3 task move` at start/end of every turn

## Additional Integrations

| Integration | Agents | Details |
|-------------|--------|---------|
| `~/.agents/AGENTS.md` | All (fallback) | Appended rule block for agents that read `AGENTS.md` |
| `~/.claude/settings.json` | Claude Code | Auto-adds `Bash(~/.dev3.0/bin/dev3 *)` permission |
| `~/.codex/config.toml` | Codex | Configures `allowed_dirs` for worktrees and socket paths |
