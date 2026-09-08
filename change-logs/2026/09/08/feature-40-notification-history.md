Short: dev3 notify calls are recorded

Every `dev3 notify` the app handles is now written to `~/.dev3.0/notifications/YYYY-MM-DD.jsonl` with its time, level, surface (toast or desktop), the task it points at, the worktree it was sent from and what the app actually did with it — delivered, queued behind Focus Mode, or dropped because no window was open. History is kept for 30 days and nothing leaves the machine; notifications from a silenced project are still recorded nowhere. Nothing is shown in the UI yet — this release only starts collecting.
