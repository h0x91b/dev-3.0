Short: Merged PRs no longer read as Unknown

The PR status popover now reads a merged or closed pull request as merged or closed, drops the auto-merge and mergeability rows that no longer apply instead of showing "Unknown", says "not loaded yet" when nothing has polled the PR, and tells you inside the popover when a Refresh could not reach GitHub. The git bar and task info panel also fall back to the task's stored PR status instead of an empty badge.
