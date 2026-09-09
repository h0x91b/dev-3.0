Short: dev3 CLI cleared with Claude Code

Claude Code no longer blocks dev3's own lifecycle commands: dev3 declares the CLI to the auto-mode classifier in `~/.claude/settings.json` (the only scope that gate reads), keeping the classifier's built-in rules intact, and a task worktree now allow-lists both spellings of the CLI — the bare `dev3` the protocol asks agents to type and the absolute `~/.dev3.0/bin/dev3` (or quoted `dev3.exe` on Windows) that dev3's generated skills and hooks put in front of them.
