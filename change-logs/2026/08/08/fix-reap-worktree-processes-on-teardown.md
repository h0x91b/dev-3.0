Short: Kill leftover task processes on teardown

Completing, cancelling, deleting or hibernating a task now kills every process still running inside its worktree, not just the terminal tree and the dev server. Detached agent daemons that double-fork and hold no dev-server port — `agent-browser` with its headless Chromium, file watchers, MCP servers — used to survive teardown and keep burning CPU and memory for weeks against an already deleted worktree.
