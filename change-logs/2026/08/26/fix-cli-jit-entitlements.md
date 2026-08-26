Short: Remote access survives task creation

Creating a task no longer kills a running `dev3 remote` server on macOS, which
dropped the connected browser or phone into "Reconnecting". The CLI binary is
now signed with the JIT entitlements Bun needs, so the copy-on-write clone step
of task creation stops crashing the process outright.
