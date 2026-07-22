Short: Reliable preparation cancellation

Cancelling a task during preparation now waits up to 10 seconds for Git and setup processes to exit before best-effort cleanup, and startup safely removes abandoned `locked initializing` worktrees without touching active task worktrees.

Suggested by @nadavsheinbein (h0x91b/dev-3.0#1071)
