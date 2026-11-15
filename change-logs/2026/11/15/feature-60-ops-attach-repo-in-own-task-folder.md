Short: Attach repo from own task folder

An Operations task can now attach a git worktree or clone that its agent created inside the task's own folder; repos in another task's folder are still refused. Completing, cancelling or resetting such a task removes the linked worktree (its branch is kept, the dialog warns about unsaved work), and deleting it prunes the stale worktree entry from the main repository.
