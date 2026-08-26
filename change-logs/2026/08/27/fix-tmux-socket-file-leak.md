Short: Stop leaving dead tmux sockets

dev3 no longer accumulates dead tmux socket files in the system temp directory forever: every test that mints a pid-keyed socket now unlinks it, and the app sweeps dev3-prefixed sockets with nothing listening on them once at startup. Two leaking test temp directories were fixed the same way. Measured on the maintainer's machine: 1 374 stale socket files and 25 591 leftover directories, none of which anything ever removed.
