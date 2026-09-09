Short: dev3 CLI allowed by both spellings

A task worktree's `.claude/settings.local.json` now allow-lists both spellings of the dev3 CLI — the bare `dev3` the protocol asks agents to type and the absolute `~/.dev3.0/bin/dev3` (or quoted `dev3.exe` on Windows) that dev3's own generated skills and hooks put in front of them — so a session no longer depends on `~/.claude/settings.json` carrying the second one.
