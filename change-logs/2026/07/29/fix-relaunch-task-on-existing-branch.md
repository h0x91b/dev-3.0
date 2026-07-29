Short: Re-run tasks on an existing branch

Fixed a task launched on an existing or remote branch (for example a code-review task on `origin/<branch>`) becoming impossible to start again after it was moved back to To Do: the leftover worktree directory made `git worktree add` fail and the retry died with "a branch named X already exists". The worktree path is now reclaimed on every launch path, and a surviving local or variant branch is checked out instead of recreated, so its commits are kept.
