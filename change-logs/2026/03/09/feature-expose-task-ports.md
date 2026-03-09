Detect and display listening TCP ports for each task's tmux session. A background poller (10s interval) scans the PID tree of every active session using lsof, and pushes updates to the renderer on change. Ports appear as clickable badges in three locations: TaskInfoPanel (expanded section with process names), TaskCard (bottom row pills), TmuxSessionManager (session rows), and ActiveTasksSidebar (compact pills). Clicking a port opens http://localhost:<port> in the browser.

Suggested by @nicest (h0x91b/dev-3.0#190)
