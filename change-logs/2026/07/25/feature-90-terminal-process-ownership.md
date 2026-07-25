Short: Ownership accounting for native terminals

Added a backend-neutral process/port ownership seam so a terminal session's CPU, memory, and listening ports can be accounted for on both tmux and native backends. Ownership must be proved (tmux pane PIDs, or the native session record verified against process identity); a stale or reused PID is reported explicitly and never counted, and the snapshot reuses the existing `ps`/`lsof` scanners rather than adding a second monitor.
