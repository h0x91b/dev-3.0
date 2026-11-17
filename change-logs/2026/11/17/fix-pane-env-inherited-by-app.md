Short: Pane env no longer leaks into dev3

dev3 started from inside one of its own panes no longer passes that pane's Claude config folder, model and API keys, or tmux pane identity on to its tmux server, so projects without their own Claude folder stop running agents on another project's folder. A `CLAUDE_CONFIG_DIR` exported in your shell profile still applies.

Contributed by @fallenfuzz
