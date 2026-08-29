Short: Read every task's notes in one feed

New `dev3 events` CLI command: one feed of the notes recorded by every task on the board, including completed and cancelled ones whose worktrees are long gone. It is addressed by a cursor rather than a time window, so the same cursor always returns the same answer and nothing is silently skipped — a bare call shows the last 24 hours and states, as a number, how many events are older than that window.
