Short: Fix blocked terminal launches

A tmux client/server version mismatch after an app update could block every new task and project terminal from starting until all tmux sessions were killed. dev3 now detects the mismatch at startup, reuses a compatible client found later in PATH when available, and gives the exact tmux Sessions → Kill All recovery when it is not.
