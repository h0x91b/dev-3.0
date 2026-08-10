Short: Task image history is no longer capped

Images an agent shares with `dev3 show-image` are no longer capped at 50 per task — the 51st image used to silently drop and delete the oldest one. The whole history is kept now, exactly like shared artifacts, and the stored files still die with the worktree.
