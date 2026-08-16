Short: App no longer freezes on startup

Fixed the app hanging forever on the "Checking system…" startup screen, where Reload and Retry both re-armed the freeze. Every tmux command now gives up and cleans up after itself instead of waiting on an unresponsive tmux server — previously an unanswered command waited forever, and the pane pollers could pile up thousands of stuck tmux processes that saturated the machine and froze the app.
