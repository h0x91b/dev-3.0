Short: Merged-and-rebased branches detected

A branch that was squash-merged and then rebased (no commits of its own left) is no longer reported as "not fully merged" — dev3 now confirms it through the task's own merged pull request before offering completion, while brand-new branches with no work stay untouched. The branch-status toast also names the real blocker (uncommitted changes, a non-base compare ref, or an ineligible task status) instead of always claiming the branch is unmerged.
