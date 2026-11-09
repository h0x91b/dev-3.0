Short: Coordinator follows your repo's git flow

The built-in coordinator brief no longer assumes GitHub pull requests into main, rebasing and CI: it follows the branch, merge and check rules in the repo's own docs (or asks), puts the target branch in each child's brief, and counts work as landed once it is merged into that target. A coordinator brief customised in Settings or Project Settings keeps its own wording; use its Reset button to pick up the new default.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2244)
