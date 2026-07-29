Short: Resume survives a stale session id

Resuming a task no longer dies with "No conversation found with session ID" when the stored agent session id has no transcript on disk. dev3 now checks the id against the agent's transcript store first and reopens the newest surviving conversation for that worktree instead, repairing the stored pointer so later resumes are clean.
