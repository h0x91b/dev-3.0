Short: Failed cleanups stay recoverable

Task completion and cancellation now report Git worktree removal failures instead of clearing the worktree path and branch, preserving teardown state for retry or manual cleanup.

Suggested by @nadavsheinbein (h0x91b/dev-3.0#1070)
