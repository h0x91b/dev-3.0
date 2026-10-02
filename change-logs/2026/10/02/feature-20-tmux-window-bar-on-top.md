Short: Slanted tmux window tabs, on top

The tmux window bar now sits at the top of every task terminal and only appears while the session has more than one window, so a lone window gets its row back and a window opened by Cmd+T or by an agent shows up where the eye starts instead of looking like the task was lost. Its tabs are restyled as slanted Catppuccin tabs with nothing else on the bar, and a plain shell tab is labelled by its running command instead of the machine's hostname. Live sessions pick it up without a restart, and Alt-click cursor moves account for the bar's new position.
