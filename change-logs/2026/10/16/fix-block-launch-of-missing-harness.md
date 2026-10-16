Short: Missing harnesses no longer launch

Launching a task with a harness that is not installed (e.g. Oh My Pi) is now refused before the task moves: the launch dialog disables Launch, shows the install command for the selected harness and platform with a Copy button, and offers Check again; CLI, scheduled, extra-agent and bug-hunter launches are refused the same way. When a pane does wait for an install, Oh My Pi's status hook now goes to the agent instead of breaking the shell with "zsh: no such option: hook".
