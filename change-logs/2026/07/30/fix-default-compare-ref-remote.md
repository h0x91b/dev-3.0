Short: Diff defaults to origin/main again

New projects with a single committer no longer default their diff comparison to the local base branch — when `origin/<base>` exists it always wins, so freshly cloned repos compare against `origin/main` instead of a local `main` that dev3 never fast-forwards.
