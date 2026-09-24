Short: Parallel task launches survive git lock races

Launching many tasks at once no longer drops one of them when another git process holds the repository config lock: worktree creation now retries with jittered exponential backoff for up to 8 attempts or 12 seconds, also rides out a sibling worktree that is still initializing, and says how long it waited when it finally gives up.
