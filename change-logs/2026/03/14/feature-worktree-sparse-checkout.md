Added Worktree File Filter in Project Settings. For large monorepos, users can now toggle off "Include All Files" and specify which directories to check out into worktrees using git sparse-checkout (cone mode). This dramatically speeds up worktree creation and saves disk space when only a subset of the repository is needed. Also added unsaved changes guard — navigating away from project settings now prompts to save or discard, with a sticky Save banner at the top when the form is dirty.

Suggested by @nickhudkins (h0x91b/dev-3.0#315)
