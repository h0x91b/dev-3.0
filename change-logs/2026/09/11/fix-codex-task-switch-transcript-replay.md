Short: No more transcript replay on task switch

Switching to a Codex task no longer scrolls the whole conversation past. A reconnected viewer was repainted by nudging the terminal one row and back, and Codex answers a height change by clearing its scrollback and re-emitting the entire transcript — twice per switch. tmux now repaints its own client with `refresh-client`, which the agent in the pane never sees.
