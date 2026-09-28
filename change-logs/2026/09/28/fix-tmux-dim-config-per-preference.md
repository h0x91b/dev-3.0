Short: Dim-panes choice no longer overwritten

Turning off Settings → Terminal → Dim inactive panes no longer gets undone when another dev3 process on the same machine (a second build or QA instance) starts: each dimming choice now has its own tmux config file, so the app always re-applies its own setting when it opens a terminal.
