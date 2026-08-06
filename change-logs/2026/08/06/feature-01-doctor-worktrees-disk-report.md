Short: See and reclaim worktree disk

`dev3 doctor --worktrees` reports what `~/.dev3.0/worktrees` keeps on disk per project and how much of it is reclaimable: orphaned directories whose task record no longer exists, worktrees whose teardown never finished, and old diffs/logs of long-finished tasks. Report-only by default; `--prune-orphans` and `--prune-older-than <duration>` delete, and a directory on an unmerged `dev3/task-*` branch is skipped unless you add `--force-unmerged`.
