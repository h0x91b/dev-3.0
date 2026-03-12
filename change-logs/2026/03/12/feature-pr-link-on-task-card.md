Task cards on the Kanban board now display a clickable PR badge (e.g. "PR #123") when the task's branch has an open pull request. The info panel also shows the PR number prominently in the git status row and metadata grid. PR data is fetched once per project via `gh pr list` and refreshed every 60 seconds.

Suggested by @sapirch (h0x91b/dev-3.0#286)
