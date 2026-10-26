Short: Task terminals keep folder access

Task terminals on macOS no longer lose access to ~/Documents, ~/Desktop and Full Disk Access after dev-3.0 restarts or updates: the bundled tmux server now starts as a per-user launchd job, so macOS keeps crediting it to the app's existing permissions.
