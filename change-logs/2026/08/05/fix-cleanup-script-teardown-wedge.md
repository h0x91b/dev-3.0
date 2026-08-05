Short: Stuck "Shutting down" cards fixed

Task teardown no longer hangs forever when the cleanup script's tmux client refuses to exit: an orphaned client is detected and killed within seconds, a genuinely long script gives up at a 10-minute cap, and worktree removal plus the final status write always run. The cleanup step now logs its spawn, exit code and duration.

Suggested by @DolevEpshtein (h0x91b/dev-3.0#1251)
