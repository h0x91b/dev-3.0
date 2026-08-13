Short: Turn the PR task link on/off

Global Settings → Behavior now has a "Task link in pull requests" toggle (default on) to stop dev3 from adding the origin-task deep link to PRs it opens — useful when a public PR shouldn't reveal that it was made with dev3. Also fixes from the #1339 review: the footer no longer renders its divider as a heading, the handoff prompt is a single line so it can't submit early on non-Claude agents, and the two links in the footer now carry identical ids.
