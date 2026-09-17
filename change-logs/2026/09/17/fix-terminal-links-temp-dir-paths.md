Short: Clickable /tmp paths in terminal

File paths under the OS temp directory (`/tmp`, `$TMPDIR`, and their `/private` spellings on macOS) printed in terminal output now become Cmd/Ctrl+Click links, so screenshots and scratch files that agents such as Codex park there open like any worktree path. Previously the path-scope gate admitted only the home directory and registered project roots, so those paths silently stayed plain text. Because those directories are world-writable, a link there is followed before it is allowed: one that points outside the allowed directories stays plain text.
