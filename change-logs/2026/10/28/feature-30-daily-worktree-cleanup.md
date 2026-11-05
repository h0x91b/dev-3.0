Short: Old task files cleaned up daily

dev3 now runs `dev3 doctor --worktrees --prune-older-than 14d` by itself once a day, never in the first hour after launch, removing diffs, logs and leftover worktrees of tasks finished over 14 days ago (unmerged branches wait 60 days and keep their branch) and gzipping the diff snapshots that remain; turn it off in Settings → System → "Clean up old task files". `--prune-older-than` now honours durations under 30 days and also covers orphaned folders and unfinished teardowns.
