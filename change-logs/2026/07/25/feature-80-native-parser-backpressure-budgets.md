Short: Bounded native terminal snapshot writes

The experimental native terminal parser now publishes read-only queue, persistence, and resync counters, caps snapshot writes at one per pane per second, skips writes whose screen is unchanged, and never keeps more than one write in flight. A real-PTY load probe across 1, 6, and 20 streams measured roughly half the persisted bytes and a peak write rate of at most one per second per pane, with unchanged parsing and cleanup behaviour. tmux remains the production default and is untouched.
