Added per-task port allocation. When `portCount` is set in project config, free TCP/UDP ports from the 10000–20000 range are allocated for each task and injected as `$DEV3_PORT0`, `$DEV3_PORT1`, `$DEV3_PORTS`, and `$DEV3_PORT_COUNT` environment variables. Ports are propagated to tmux sessions, dev server scripts, and spawned agents, and released when tasks complete.

Suggested by @roiros (h0x91b/dev-3.0#328)
