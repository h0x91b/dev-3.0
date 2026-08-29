Short: Resuming keeps the right conversation

Fix a pane whose conversation started in another directory silently getting a brand-new conversation on the first recovery. Such a transcript stays in its original directory's store, but the agent still creates an empty store directory for the task's own worktree — enough for the resume resolver to conclude the session was dead and fall back to starting fresh. It now records the conversation's origin directory and checks that store before healing.
