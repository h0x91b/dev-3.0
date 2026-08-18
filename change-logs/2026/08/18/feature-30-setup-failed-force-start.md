Short: Start the agent after a failed setup

When a project's setup script fails, the task pane now offers to start the agent anyway instead of leaving you with a bare shell. Previously a failed setup in `blocking` launch mode (or on the native terminal backend) meant the agent never launched at all and there was no way to reach the task's prompt short of recreating the task.
