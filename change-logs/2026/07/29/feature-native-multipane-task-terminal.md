Short: Real split panes on native terminals

The task terminal's split, focus, resize, zoom, close and layout controls now work on tasks running the native (non-tmux) terminal backend: each visible pane is a real terminal with its own shell, and the layout survives an app restart or a browser reconnect. tmux-backed tasks keep their existing behaviour, and controls a backend cannot serve are visibly disabled instead of failing silently.
