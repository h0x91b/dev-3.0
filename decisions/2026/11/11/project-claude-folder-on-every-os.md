# Per-project Claude folder on every OS: a git-ignore rule instead of a macOS gate

## Context
The "Each project uses its own Claude folder" switch writes `CLAUDE_CONFIG_DIR={projectPath}/.claude` into `agentEnvDefaults`. It worked only on macOS (`projectClaudeFolderSupported`), because Claude Code on Linux and Windows writes its login to `.credentials.json` inside the config dir. The drop matched the exact string, so `{projectPath}/.claude/` slipped past it unchecked. Users who keep a login per project on Linux had to write `.dev3/config.local.json` into every repo.

## Decision
- `applyAgentEnvDefaults` (`src/shared/agent-env-defaults.ts`) asks a host predicate about any `CLAUDE_CONFIG_DIR` default that contains `{projectPath}`, in any spelling. A project's own env value is never questioned.
- `projectClaudeConfigDirAllowed` (`src/bun/claude-config-git.ts`), wired in `resolveProjectEnv`: Operations (virtual) boards never take the default, on any OS, because their `{projectPath}` is dev3's own `~/.dev3.0/ops/<name>`. macOS allows it, because the login is in the Keychain. Elsewhere dev3 first writes its `info/exclude` rules (`excludeClaudeRuntimeState`, which now also works before the folder exists) and then allows the folder only when `git check-ignore` says `.credentials.json` is ignored. A tracked login file, a folder outside a git repo, or a `.gitignore` negation keeps the agent on `~/.claude`.
- `normalizeClaudeConfigDir` (`src/shared/claude-config-dir.ts`) normalizes separators through the host's `path`, so a Windows `C:\repo/.claude/` and `C:\repo\.claude` are one dir. `usesProjectClaudeConfigDir` reads any trailing-separator spelling as the switch being on.
- The Settings switch is offered on every OS; its copy states the Linux and Windows rule and that a task started before a switch cannot resume its conversation after it.

## Risks
- `info/exclude` is per clone. Docker build contexts, archives and cloud sync do not read it, and on Linux and Windows the file they would carry is now a login token, not only history. The switch copy says so; a `.dockerignore` is the user's call.
- The check spawns `git check-ignore` on every launch and on every read of a project's login (`listPinnedClaudeLogins`). It is one short call per project; the exclude write runs once per dir per process.
- A macOS user with an Operations board and the switch on loses that board's folder: its tasks return to `~/.claude` and cannot resume conversations started in `~/.dev3.0/ops/<name>/.claude`.
- A project refused on Linux falls back to `~/.claude` silently in the UI; only the log says why.

## Alternatives considered
- Keep the macOS gate and document the trailing-slash spelling. Rejected: it is a bug that anyone can fix away, and it leaks the login on a repo that tracks `.claude/`.
- Require a `.gitignore` entry and never count `info/exclude`. Rejected: dev3 already relies on `info/exclude` for the rest of the runtime state, and editing a tracked `.gitignore` is ruled out by `decisions/2026/11/04/per-project-claude-config-dir.md`.
- Offer the pin per project at Add Project time. Deferred: once the global default works everywhere it already pins every added project, and placing a new prompt in the add flow needs its own UX pass.
