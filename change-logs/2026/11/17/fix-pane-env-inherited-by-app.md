Short: Pane env no longer leaks into dev3

dev3 started from inside one of its own panes now drops that pane's environment and reads your login shell's again, so its tmux server no longer hands that pane's Claude folder, Claude Code session keys, model pins, project env, task identity and artifact template setting to every other terminal, native terminals included. A tmux server already running keeps its old environment until it restarts.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2330)
