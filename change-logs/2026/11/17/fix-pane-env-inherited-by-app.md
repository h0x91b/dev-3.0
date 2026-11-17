Short: Pane env no longer leaks into dev3

dev3 started from inside one of its own panes now starts from a clean environment plus your login shell's, as a fresh terminal would, so its tmux server no longer hands that pane's Claude folder, Claude Code session keys, model pins, project env and task identity to every other terminal. A tmux server already running keeps its old environment until it restarts.

Contributed by @fallenfuzz
