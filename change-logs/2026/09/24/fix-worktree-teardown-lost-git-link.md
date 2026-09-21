Short: Unstick teardown of a broken worktree

A task whose worktree directory survived while its `.git` link did not could never finish tearing down: `git worktree remove` rejected it on every app start, so the task stayed in `tearing-down` and the same error came back at the next boot forever. That failure is now treated like any other "git has no working tree here" case — the stale registration is pruned and teardown completes. A locked or otherwise removable worktree still rejects as before.
