Short: Backend-neutral read-only pane capture

The terminal-backend seam gained `captureView`, one read-only way to read a named pane's recent text on both the tmux and native backends without focusing it, typing into it, resizing it, or depending on the pane's agent. It reports the visible screen and scrolled-off history separately, says when the content was actually observed, and names every unavailable case explicitly instead of returning an empty string. Native panes report `not-enabled` for now, because the host's live parser stays off by default.
