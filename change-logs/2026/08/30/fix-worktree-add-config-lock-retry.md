Short: Variant starts no longer lose a git lock race

Starting a task with several variants could fail with "could not lock config file .git/config: File exists", because the variants write their branch tracking config at the same moment. Worktree creation now retries up to three times with backoff, cleaning up the half-created branch between attempts.
