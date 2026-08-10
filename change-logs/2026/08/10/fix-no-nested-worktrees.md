Short: Stop agents nesting git worktrees

The dev3 agent protocol now states that the managed worktree is the isolation boundary, so agents no longer create a nested git worktree, clone, or side checkout when an unrelated skill or workflow asks for one. An explicit user request still overrides it.

Reported by Bar Volovsky
