Short: Messages reach an agent restarted by hand

`dev3 message` no longer refuses a task whose agent was started again by hand in the shell its exited agent left behind: the pane's agent binary running there counts as the main agent again, for messages, `dev3 pane list` handles and the keep-alive watchdog, which no longer tears such a pane down.
