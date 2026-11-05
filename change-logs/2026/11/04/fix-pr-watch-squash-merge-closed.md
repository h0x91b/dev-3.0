Short: pr watch reports squash merges as merged

`dev3 pr watch` no longer tells an agent a merged pull request was "closed without merge": a PR is read as merged whenever GitHub has a merge time for it, and a close is only reported once a later poll still sees the PR closed, so a merge that GitHub briefly shows as closed is reported as merged.

Suggested by @sworgkh (h0x91b/dev-3.0#2168)
