Short: Agents exit cleanly when a task ends

Completing, cancelling, hibernating or deleting a task now asks the agent to quit on its own terms before the terminal is torn down: dev3 types the CLI's quit command (Ctrl-C, then `/exit` or `/quit`, then Enter) into every live agent pane and waits up to 30 seconds for the agent process to leave, so Claude Code's SessionEnd hooks — and any other harness's exit-time work — run instead of being killed with the tmux session or native host. A hook that hangs only costs that bound; the timeout is logged and teardown proceeds as before.
