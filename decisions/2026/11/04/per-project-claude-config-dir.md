> Superseded in part on 2026-11-05 by `decisions/2026/11/05/project-claude-pin-beats-default-account.md`: the default managed account no longer overrides a project pin.

# Per-project Claude config dir: switch, git hygiene, task-local settings

## Context
Some users run every project with `CLAUDE_CONFIG_DIR=<project>/.claude` and never use `~/.claude`. dev3 already honoured a pinned dir (`ensureClaudeConfigDir`, #1877) and expands `{projectPath}` in the global `agentEnvDefaults`, but nothing in the UI suggested it, and a dir inside a repo had problems: Claude's runtime files showed up in `git status`, dev3 patched a committed `settings.json` with a home-dir socket path, and transcript discovery ignored the dir.

## Decision
- The Settings switch only adds or removes `CLAUDE_CONFIG_DIR={projectPath}/.claude` in `agentEnvDefaults` (`withProjectClaudeConfigDir`, `src/shared/agent-env-defaults.ts`). There is no new stored field: the env map stays the single source of truth.
- `excludeClaudeRuntimeState` (`src/bun/claude-config-git.ts`) adds anchored rules to the repo's `info/exclude` for Claude's runtime state and dev3's skill dirs, the same mechanism auto-configure uses. It runs once per dir per process.
- When the pinned dir's `settings.json` is git-tracked, `ensureClaudeConfigDir` sends dev3's settings patch to the task folder's untracked `.claude/settings.local.json` (dev3-owned folders only). Otherwise it skips the patch.
- `claudeConfigDirs` includes the recorded pinned dirs, so search, import and resume see their transcripts.

## Risks
- `isGitTracked` and the exclude helper spawn git at launch. That is two short calls, and the exclude call runs once per dir per process.
- A pinned dir in a non-dev3-owned folder (git workflow off) whose settings are tracked gets no dev3 settings patch: no auto-allow rule for the dev3 CLI and no sandbox socket.
- An explicitly picked managed Claude account still overrides the project dir; the default account no longer does (`decisions/2026/11/05/project-claude-pin-beats-default-account.md`).

## Alternatives considered
- A dedicated boolean setting. Rejected: it would duplicate state that the env map already expresses, and the two could disagree.
- Writing excludes into `.gitignore`. Rejected: that changes a tracked file in the user's repo.
- Always patching the pinned `settings.json`. Rejected: it would commit dev3 entries and a personal home path into a shared repo.
