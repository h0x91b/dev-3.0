Short: Schedules fire on headless dev3 remote

Automations, "Start in" launches, "Send later" messages (`dev3 message --in/--at`), keep-alive revives and the daily worktree cleanup now run under headless `dev3 remote`; before, only the desktop app started those schedulers, so on a headless box they stayed overdue forever. Both entries now start them through one shared call, and a test fails if headless skips anything the desktop starts.
