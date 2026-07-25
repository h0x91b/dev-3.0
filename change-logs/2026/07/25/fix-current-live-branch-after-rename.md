Short: dev3 current shows renamed branch instantly

`dev3 current` and `dev3 task show` now reconcile the stored branch name with the branch actually checked out in the worktree, so a `git branch -m` is reflected immediately instead of waiting for the app's next branch-status poll. Offline mode reads the live branch straight from the worktree too.

Suggested by @nadavsheinbein (h0x91b/dev-3.0#1003)
