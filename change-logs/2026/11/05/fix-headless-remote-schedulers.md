Short: Schedules fire on headless dev3 remote

Automations, "Start in" launches, "Send later" messages (`dev3 message --in/--at`), keep-alive revives and per-task focus time now run under headless `dev3 remote`; before, only the desktop app started them, so on a headless box schedules stayed overdue forever and focus time stayed at zero. Both entries now start them, and the daily worktree cleanup, through one shared call, and a test fails if headless skips anything the desktop starts.
