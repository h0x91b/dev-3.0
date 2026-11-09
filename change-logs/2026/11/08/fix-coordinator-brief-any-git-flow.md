Short: Coordinator follows your repo's git flow

The built-in coordinator brief no longer assumes GitHub pull requests into main, rebasing and CI: it follows the branch, merge and check rules in the repo's own docs (or asks), puts the target branch in each child's brief, and counts work as landed once it is merged into that target.
