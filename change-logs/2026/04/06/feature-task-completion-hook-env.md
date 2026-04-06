Cleanup Script now runs as a teardown hook for completed and cancelled tasks with lifecycle env vars such as DEV3_TASK_STATUS, DEV3_TASK_FROM_STATUS, DEV3_TASK_TO_STATUS, DEV3_PROJECT_PATH, and DEV3_WORKTREE_PATH. Project Settings text and agent-facing docs now describe the real behavior, and a new tip highlights branching cleanup logic by task status.

Suggested by @genrym (h0x91b/dev-3.0#361)
