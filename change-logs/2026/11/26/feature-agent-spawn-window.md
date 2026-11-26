Short: Spawn agents in a separate tab

`dev3 agent spawn --window [name]` opens the new agent in its own tmux tab of the task session (default tab `Agents`, found or created) instead of splitting the current one. The approval dialog names the tab, and `dev3 agent resume` reopens such an agent in the same tab.
