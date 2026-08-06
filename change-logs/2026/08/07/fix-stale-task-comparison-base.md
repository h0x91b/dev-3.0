Short: Task git numbers stop trusting a dead base

A task's ahead/behind counts, diff chip, PR badge and Rebase (AI) target could stay pinned to an already-merged review branch after the task's own branch was renamed, so every number described someone else's branch. The comparison base now survives a rename, retires itself once that branch is merged or gone, is fetched from the remote that actually owns it, and a stored pull request only counts while it belongs to the task's own branch.
