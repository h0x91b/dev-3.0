Short: Agent config stays in settings.local.json

dev3's worktree permission (`Bash(dev3:*)`) now always goes to `.claude/settings.local.json`, never to a committed `.claude/settings.json`. Hooks, MCP pre-approval and Codex hooks are skipped with a warning when their path in the worktree is a symlink leading outside it, so a settings file linked into a shared config repo is never rewritten.
