Short: Dev server and Rebase panes work natively

On a task using the native terminal backend, starting the dev server or running Rebase opens a real visible pane in the task's own terminal instead of failing invisibly — the dev server used to run hidden in a tmux session a native task should never touch, and the git panes errored out. Repeated clicks reuse the one pane, the agent pane keeps its focus, and closing a task now also stops a native dev server instead of leaking its processes and ports.
