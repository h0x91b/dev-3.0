Short: Finish removing large worktrees on completion

Completing or cancelling a task whose worktree holds a large untracked tree (such as a Python `.venv`) no longer leaves it half removed when git stops part way: dev3 now deletes the leftover task folder itself. If even that fails, `dev3 task move` exits with code 48, names the folder and says how to finish, instead of the task silently staying in its column.

Suggested by @h0x91b (h0x91b/dev-3.0#2269)
