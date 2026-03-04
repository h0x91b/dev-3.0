Fix false "pushed but not merged" warning when moving a task to completed.

`getBranchStatus` was comparing the task branch against the local `main` branch instead of `origin/main`. Since `git fetch origin` only updates the remote tracking ref, the local branch stayed stale after a PR was merged on GitHub. Additionally, `fetchOrigin` and `getBranchStatus` ran in parallel, so the fetch result wasn't guaranteed to be available. Fixed by awaiting the fetch first, then comparing against `origin/<baseBranch>` in both `getBranchStatus` and `mergeTask` handlers.
