Fix creating a task from an existing branch that is already checked out in another worktree. Previously `git worktree add` would fail with "already used by worktree" error. Now falls back to creating a new task branch (`dev3/task-<id>`) based on the existing branch's HEAD when direct checkout is not possible.

Suggested by @yoavf (h0x91b/dev-3.0#189)
