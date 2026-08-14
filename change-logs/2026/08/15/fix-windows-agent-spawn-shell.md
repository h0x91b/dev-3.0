Short: Adding an agent works on Windows

Adding a second agent to a task on Windows failed with "requested shell executable not found: /bin/bash" — the pane spawn path hardcoded a POSIX shell. The generated wrapper is now launched through the platform dialect (bash on macOS/Linux, PowerShell with a .ps1 wrapper on Windows), and when a launch fails because the shell could not be resolved the error hint says so instead of telling you to check that the agent is installed. The agent's PATH is also joined with the platform's own separator now, instead of always a colon.
