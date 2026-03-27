# Agent Support Matrix

Feature compatibility across supported AI coding agents.

Last updated: 2026-03-27

## Agents

| Agent | CLI binary | Skill directories |
|-------|-----------|-------------------|
| Claude Code | `claude` | `~/.claude/skills/dev3/`, `~/.claude/skills/dev3-project-config/` |
| Cursor Agent | `agent` | `~/.cursor/skills/dev3/`, `~/.cursor/skills/dev3-project-config/` |
| Codex | `codex` | `~/.codex/skills/dev3/`, `~/.codex/skills/dev3-project-config/` |
| Gemini CLI | `gemini` | `~/.gemini/skills/dev3/`, `~/.gemini/skills/dev3-project-config/` |
| OpenCode | — | `~/.opencode/skills/dev3/`, `~/.config/opencode/skills/dev3/`, `~/.opencode/skills/dev3-project-config/`, `~/.config/opencode/skills/dev3-project-config/` |

## Feature Matrix

| Feature | Claude Code | Cursor Agent | Codex | Gemini CLI | OpenCode |
|---------|:-----------:|:------------:|:-----:|:----------:|:--------:|
| **Skill injection** | Yes (`!` command syntax) | Yes (generic) | Yes (generic) | Yes (generic) | Yes (generic) |
| **System prompt injection** | `--append-system-prompt` | via prompt arg | via prompt arg | — | via `--prompt` |
| **Session resume** | `--continue` | `--continue` | `resume --last` | `--resume latest` | `--continue` |
| **Permission mode** | `--permission-mode` | `--mode plan` / `--force` | `--permission-mode` | `--approval-mode` | — |
| **Effort level** | `--effort` | — | `--effort` | — | — |
| **Max budget** | `--max-budget-usd` | — | `--max-budget-usd` | — | — |
| **Model selection** | `--model` | `--model` | `--model` | `--model` | `--model` |
| **Agent selection** | — | — | — | — | `--agent` |
| **Auto-trust worktree** | Yes (`ensureClaudeTrust`) | — | — | Yes (`ensureGeminiTrust`) | — |
| **Status hooks (automatic)** | Yes (4 hooks) | — | Yes (4 hooks) | — | — |
| **Status management** | Automatic via hooks | Manual (SKILL.md) | Automatic via hooks with `user-questions`/legacy-session fallback | Manual (SKILL.md) | Manual (SKILL.md) |

## Status Hooks

Injected per-worktree at task launch.

### Claude Code

Injected into `.claude/settings.local.json`.

| Hook event | Status transition | Purpose |
|------------|------------------|---------|
| `UserPromptSubmit` | → `in-progress` | User sent a message, agent starts working |
| `PreToolUse` | → `in-progress` | Agent is about to call a tool (also catches post-permission resume) |
| `PermissionRequest` | → `user-questions` | Agent needs user approval for a tool call |
| `Stop` | → `review-by-user` | Agent finished its turn |

### Codex

Injected into `.codex/hooks.json` and enabled via `~/.codex/config.toml` (`[features] codex_hooks = true`).

| Hook event | Status transition | Purpose |
|------------|------------------|---------|
| `SessionStart` | → `in-progress` | Marks startup/resume turns as active |
| `UserPromptSubmit` | → `in-progress` | User sent a message, agent starts working |
| `PreToolUse` (`Bash`) | → `in-progress` | Agent is about to run a shell command |
| `Stop` | → `review-by-user` | Agent finished its turn |

## Skill Differences

### dev3 (task lifecycle)

The dev3 skill (`SKILL.md`) is installed into each agent's skill directory. Two variants exist:

- **Claude variant** — simplified status section (hooks handle transitions automatically), uses `!` command injection for zero-tool-call startup
- **Codex variant** — hook-aware status section with manual fallback for older sessions, keeps the `/bin/bash` shell note
- **Generic variant** — full manual status management instructions ("CRITICAL — NON-NEGOTIABLE"), requires agents to run `dev3 task move` at start/end of every turn

### dev3-project-config (project configuration)

A supplementary skill that teaches agents about `.dev3/config.json` and `.dev3/config.local.json`. Covers the schema, merge priority, when to create/modify config files, and CLI commands (`dev3 config show`, `dev3 config export`). Same content for all agents (no variant differences).

## Additional Integrations

| Integration | Agents | Details |
|-------------|--------|---------|
| `~/.agents/AGENTS.md` | All (fallback) | Appended rule block for agents that read `AGENTS.md` |
| `~/.claude/settings.json` | Claude Code | Auto-adds `Bash(~/.dev3.0/bin/dev3 *)` permission |
| `~/.codex/config.toml` | Codex | Configures trust, sandbox access, and enables `codex_hooks` |
| `<worktree>/.codex/hooks.json` | Codex | Auto-installs SessionStart/UserPromptSubmit/PreToolUse(Bash)/Stop lifecycle hooks |
