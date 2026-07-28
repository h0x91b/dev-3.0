Short: Tasks complete despite orphan worktrees

Completing a task no longer fails with "Failed to remove worktree … is not a working tree". When git has no metadata for the worktree path there is nothing left to remove, so dev3 now reclaims the orphan directory, prunes git metadata and finishes the move to Completed; genuinely refused removals (for example a locked worktree) still surface an error.

Reported by Evgeny Alterman.
