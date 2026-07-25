Short: Commit button in the git row

The task inspector's git row now has a Commit button that hands the commit to the agent in the task terminal — it reviews the changes, stages them and writes the message, without pushing. It lights up only when the worktree has uncommitted changes, and it is also available as a row in the narrow-viewport actions sheet.

Suggested by @genrym (h0x91b/dev-3.0#271)
