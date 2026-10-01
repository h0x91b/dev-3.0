Short: dev3 follows CLAUDE_CONFIG_DIR for Claude

dev3 now writes its Claude skills, its `settings.json` entries (dev3 CLI permission, sandbox socket, auto-mode exception) and worktree trust into the config dir a launch pins through `CLAUDE_CONFIG_DIR`, instead of `~/.claude` that such an agent never reads, and the statusLine wrapper finds your own statusLine there too. Headless `dev3 remote` now installs the dev3 skills on startup like the desktop app does.
