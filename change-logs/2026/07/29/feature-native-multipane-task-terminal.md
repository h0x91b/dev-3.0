Short: Real split panes on native terminals

The task terminal's split, focus, resize, zoom, close and layout controls now work on tasks running the native (non-tmux) terminal backend: each visible pane is a real terminal with its own shell, and the layout survives an app restart or a browser reconnect. On narrow viewports, native panes use the same swipeable carousel as tmux. tmux-backed tasks keep their existing behaviour unchanged, and controls a backend cannot serve are visibly disabled with a reason instead of failing silently.
