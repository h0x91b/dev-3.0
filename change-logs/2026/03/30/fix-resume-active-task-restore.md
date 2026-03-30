Restore active task terminals in resume mode after app relaunch by treating persisted worktree-backed tasks as already launched sessions. Dead in-memory PTY sessions are now discarded before restore so reopening does not reuse the stale launch command and replay the original task prompt.

Suggested by @genrym (h0x91b/dev-3.0#379)
