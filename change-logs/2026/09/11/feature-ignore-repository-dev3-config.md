Short: Ignore a repo's dev3 config

Project Settings → Project Config now carries a "Use repository dev3 configuration" switch, on by default. Turn it off and dev3 stops reading `.dev3/config.json` and `.dev3/config.local.json` for that project — from the checkout and from task worktrees alike — resolving settings from dev3's own data and built-in defaults instead, and saving Project Settings into dev3 rather than back into a repository file. The choice lives only in dev3's project data: no file is created in the repo and `.gitignore` is untouched. Nothing already running is restarted or cleaned up, and switching back on restores every repo value immediately.

Suggested by @Paveltarno (h0x91b/dev-3.0#1683)
