# A project's own Claude folder beats the default managed account

## Context

A project can pin `CLAUDE_CONFIG_DIR=<project>/.claude` (Settings → Agents → "Each project uses its own Claude folder", or its own env). Adding any managed Claude account in Settings → Accounts made every launch inject that account's `CLAUDE_CONFIG_DIR` over the pin, so the project's rules, agents, skills and memory stopped loading. Only Auto routing backed off, and it then fell back to the same default account.

## Decision

`resolveLaunchAccount` in `src/bun/agents.ts` keeps the project folder when the project pins one and the launch has no explicit pick (no account, Auto, or a removed stored account). It returns `keepsProjectClaudeConfig`, and `applyClaudeAccountEnv` then clears a previous API profile's leftovers but injects no `CLAUDE_CONFIG_DIR`. An account picked for the task, or the system login picked explicitly, still wins. The pin signal is `CommandOptions.claudeConfigPinned` (set by `task-launch.ts` and the extra-pane resume in `resume.ts` through `projectPinsClaudeConfig`) or the fresh-launch `autoRouting.claudeConfigPinned`.

## Risks

A pane launched before this change on the default account stored that account's id, so its resume reads it as an explicit pick and stays on the account until a fresh launch. Usage for a pinned launch is attributed by its config dir (the `claude-usage-owner-from-config-dir` record), not to the default account.

## Alternatives considered

Letting the pin win over every pick would silently ignore a deliberate per-task choice unless the picker is also hidden for pinned projects. Keeping the old rule leaves the pin useless as soon as one managed account exists.
