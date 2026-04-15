Preparing tasks now emit step-by-step timing logs for project config resolution, worktree creation, sparse checkout, clone-path reuse, PTY launch, and key git substeps so slow or stuck setup leaves a usable performance trail. Added a Cancel action on Preparing cards that kills tracked setup subprocesses with `kill -9`, cleans up partial task state, and returns the task to To Do instead of leaving it hung forever.

Suggested by @alonkochba (h0x91b/dev-3.0#442)
