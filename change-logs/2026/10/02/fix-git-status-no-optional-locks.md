Short: Fewer index.lock clashes while dev3 polls

dev3's background `git status` checks now run with `--no-optional-locks`. They no longer hold `.git/index.lock` while scanning a worktree, so an agent's or your own `git add`/`commit` in that repo stops failing with "index.lock: File exists" because of dev3's polling. Porcelain `git diff` still refreshes the index on its own when files were only touched, so a few lock clashes can remain.
