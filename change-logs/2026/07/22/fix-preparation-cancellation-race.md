Short: Reliable preparation cancellation

Cancelling a task during preparation now waits for Git and setup processes to exit before cleanup, and startup safely removes abandoned `locked initializing` worktrees without touching active task worktrees.

Suggested by @nadavsheinbein (h0x91b/dev-3.0#1071)
