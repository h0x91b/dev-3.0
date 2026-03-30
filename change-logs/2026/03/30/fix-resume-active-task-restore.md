Restore active task terminals in resume mode after app relaunch by treating persisted worktree-backed tasks as already launched sessions. This prevents the original task prompt from being replayed when reopening review or question-waiting tasks after a reboot or app restart.

Suggested by @genrym (h0x91b/dev-3.0#379)
