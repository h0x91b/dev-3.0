Short: Native multi-pane terminal coordinator

Added a native multi-pane terminal session coordinator that composes one persistent PTY host per logical pane, with a shared split layout, client-local focus and zoom, writer-owned resize, and recovery of the same panes and processes after an app restart. Internal groundwork for running terminals without tmux — no product surface changes, tmux remains the default.
