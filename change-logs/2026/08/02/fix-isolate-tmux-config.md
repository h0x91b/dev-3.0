Short: tmux panes ignore your personal tmux.conf

The dev3 tmux server now runs exclusively on the bundled config and no longer sources `/etc/tmux.conf`, `~/.tmux.conf` or `~/.config/tmux/tmux.conf`. Personal prefix keys, plugin managers and status-line overrides can no longer change how dev3 terminals behave; detached sessions also pass `-f` now, so the config is identical no matter which session starts the server. Your own tmux on the default socket is unaffected.
