Short: Second instance no longer kills preparing tasks

A second dev3 instance on the same machine (for example a dev build started from a task) no longer deletes the worktree of a task another running instance is still preparing. An agent asking to start another task now waits for its preparation and exits 44 with the error when it fails, instead of reporting a start that never happened.
