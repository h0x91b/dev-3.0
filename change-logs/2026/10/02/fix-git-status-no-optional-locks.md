Short: Fewer index.lock clashes while dev3 polls

dev3's background `git status` checks now run with `--no-optional-locks`. They no longer hold `.git/index.lock` while scanning a worktree, so an agent's or your own `git add`/`commit` in that repo stops failing with "index.lock: File exists" because of dev3's polling. The uncommitted-changes count and diff also skip `git diff` entirely when the worktree is clean. While there are real uncommitted changes, `git diff` can still briefly refresh the index, so a few lock clashes can remain.
