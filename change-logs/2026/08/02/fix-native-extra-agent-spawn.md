Short: Spawn extra agents on native tasks

The "+ Agent" action now opens its pane through the shared backend-neutral pane seam, so a task running the native terminal gets a real extra agent pane instead of a failed tmux split. Native launches no longer write a phantom tmux pane entry, a failed launch reports why instead of leaving a half-started agent, and tmux tasks keep their existing split and pane bookkeeping.
