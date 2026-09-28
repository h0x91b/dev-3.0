Short: Agent exit no longer lets dev3 type into its shell

When a task's agent exits, dev3 no longer types messages, hand-offs or scheduled prompts into the shell left behind: a per-pane fence closes at the exit, anything that raced in is saved to a file in the task's messages folder instead of running, and senders get "not delivered" (agent exited) rather than a false "delivered".
