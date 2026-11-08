# A project's own Claude folder beats the default managed account

## Context

A project can pin `CLAUDE_CONFIG_DIR=<project>/.claude` (Settings → Agents → "Each project uses its own Claude folder", or its own env). Adding any managed Claude account in Settings → Accounts made every launch inject that account's `CLAUDE_CONFIG_DIR` over the pin, so the project's rules, agents, skills and memory stopped loading. Only Auto routing backed off, and it then fell back to the same default account.

## Decision

`resolveLaunchAccount` in `src/bun/agents.ts` keeps the project folder when the project pins one and the launch has no explicit pick (no account, Auto, or a removed stored account). It returns `keepsProjectClaudeConfig`. An account picked for the task, or the system login picked explicitly, still wins. Every launch path passes its project env as `CommandOptions.projectEnv`; under a kept pin `keepProjectClaudeEnv` writes the project's `CLAUDE_CONFIG_DIR` into the agent env explicitly (a resumed split pane exports only that env) and drops the account env's `ENV_UNSET` for keys the project sets. It deletes the sentinel rather than copying the value, so a project `ANTHROPIC_MODEL` never feeds the `--model` rewrite, and an explicit pick keeps every sentinel, so a project credential never joins a picked login. The launch pill (`AgentAccountIndicator.tsx`) shows the project login as active, keeps it as a selectable row, and hides Auto, which cannot apply.

## Risks

A removed stored account under a pin is not stored again. A pane launched before this change on the default account stored that account's id, so its resume reads it as an explicit pick and stays on the account until a fresh launch. Usage for a pinned launch is attributed by its config dir (the `claude-usage-owner-from-config-dir` record), not to the default account.

## Alternatives considered

Letting the pin win over every pick would silently ignore a deliberate per-task choice unless the picker is also hidden for pinned projects. Keeping the old rule leaves the pin useless as soon as one managed account exists.
