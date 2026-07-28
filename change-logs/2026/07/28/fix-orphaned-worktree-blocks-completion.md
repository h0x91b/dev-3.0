Short: Completing a task no longer stalls

Completing a task no longer gets stuck when its worktree directory lost its git metadata: `git worktree remove` used to fail with "is not a working tree" and the task stayed in review forever. dev3 now detects the orphaned directory and deletes it directly.
