Added per-task port allocation. Projects can set `portCount` in `.dev3/config.json` to auto-allocate free ports from a dedicated range (10000-20000) when a task starts. Ports are injected as `DEV3_PORT0`..N, `DEV3_PORTS` (comma-separated), and `DEV3_PORT_COUNT` environment variables into the terminal session, dev server scripts, and spawned agents. Ports are released when the task is completed or cancelled.

Suggested by @h0x91b (h0x91b/dev-3.0#328)
