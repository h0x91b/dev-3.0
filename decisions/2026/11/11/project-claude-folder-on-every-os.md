# Per-project Claude folder on every OS: a git rule instead of a macOS gate

## Context
The "Each project uses its own Claude folder" switch writes `CLAUDE_CONFIG_DIR={projectPath}/.claude` into `agentEnvDefaults`. It worked only on macOS (`projectClaudeFolderSupported`), because Claude Code on Linux and Windows writes its login to `.credentials.json` inside the config dir. The drop matched the exact string, so `{projectPath}/.claude/` slipped past it unchecked. Users who keep a login per project on Linux had to write `.dev3/config.local.json` into every repo.

## Decision
- `applyAgentEnvDefaults` (`src/shared/agent-env-defaults.ts`) takes a required host predicate and asks it about any `CLAUDE_CONFIG_DIR` default containing `{projectPath}`. The allow check never questions a project's own env value; the launch re-check below covers every pin.
- `projectClaudeConfigDirAllowed` (`src/bun/claude-config-git.ts`), wired in `resolveProjectEnv`: Operations (virtual) boards never take the default, because their `{projectPath}` is dev3's own `~/.dev3.0/ops/<name>`. macOS allows it, because the login is in the Keychain. Elsewhere `claudeLoginKeptOutOfGit` decides: allowed when no git work tree holds the dir (resolved through symlinks), or when `git check-ignore` says `.credentials.json` is ignored with the rule the launch will write to `info/exclude` supplied through `core.excludesFile`. A tracked file or a `.gitignore` negation is refused.
- The check is read-only and never throws: it runs from read RPCs such as `listPinnedClaudeLogins`, so it must not touch repos. `ensureClaudeConfigDir` still writes the real `info/exclude` rules at launch. Only git's "not a git repository" counts as out of git; any other git error (dubious ownership, git missing) refuses.
- The launch re-checks. Off macOS, after `ensureClaudeConfigDir` provisions a pinned dir and writes `info/exclude`, it asks `git check-ignore` about `.credentials.json` with no assumed rule. If git would not ignore it (the write failed, or a negation or tracked file appeared since), the launch sets `CLAUDE_CONFIG_DIR` to `ENV_UNSET` and the agent runs on `~/.claude`. This applies to a pin from the project's own env too: a pin inside a repo that would show the login token in `git status` is never launched. `excludeClaudeRuntimeState` marks a dir done only after its write succeeds, so the next launch retries.
- The rule file the check supplies through `core.excludesFile` lives in dev3's per-user home, not the shared tmpdir.
- `normalizeClaudeConfigDir` (`src/shared/claude-config-dir.ts`) normalizes separators through the host's `path`, so `C:\repo/.claude/` and `C:\repo\.claude` are one dir. `usesProjectClaudeConfigDir` reads a trailing-slash spelling as the switch being on.
- The Settings switch is offered on every OS; its copy states the Linux and Windows rule and that a task started before a switch cannot resume its conversation after it.

## Risks
- `info/exclude` is per clone. Docker build contexts, archives and cloud sync do not read it, and on Linux and Windows the file they would carry is a login token. A project folder outside git holds it in plain sight too, as `~/.claude` does.
- If the launch fails to write `info/exclude`, that launch runs on `~/.claude` instead of the project folder; the log says why.
- The check runs two blocking git calls per call to `resolveProjectEnv`: about 5 ms on ext4, 25-35 ms on a WSL `/mnt` drive, once per project when the login list opens.
- A macOS user with an Operations board and the switch on loses that board's folder: its tasks return to `~/.claude` and cannot resume conversations started in `~/.dev3.0/ops/<name>/.claude`.
- A refused project falls back to `~/.claude` without a UI hint; only the log says why.

## Alternatives considered
- Keep the macOS gate and document the trailing-slash spelling. Rejected: anyone can fix that bug away, and it leaks the login on a repo that tracks `.claude/`.
- Write `info/exclude` during the check. Rejected: read RPCs would then edit every registered repo.
- Offer the pin per project at Add Project time. Deferred: the global default already pins every added project, and a new prompt in the add flow needs its own UX pass.
