Short: Clone paths report failed copies

A clone path that failed to copy into a new worktree used to be logged as copied and silently missing; the copy's exit code and stderr are now checked, logged as an error, and shown on the task as a dismissible notice in the terminal. A source that simply does not exist in the project root is still skipped quietly, and a failed path no longer blocks the launch.

Suggested by @diverru (h0x91b/dev-3.0#1728)
