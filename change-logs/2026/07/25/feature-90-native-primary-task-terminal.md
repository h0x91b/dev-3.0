Short: Native terminal for opted-in tasks

A task's primary terminal can now run on dev3's own native terminal host instead of tmux, when the task is explicitly opted in with `dev3 task terminal-backend --to native`. The terminal looks and behaves the same in the app, survives an app restart by reattaching to the same host and shell, and tears down only its own process tree; tmux stays the default for every other task and its behavior is unchanged. Shell scripts are now pinned to LF line endings so the CLI and Windows package builds also work from a Windows clone.
