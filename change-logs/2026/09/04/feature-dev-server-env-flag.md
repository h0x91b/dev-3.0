Short: Pass env vars to a dev server

`dev3 dev-server start --env KEY=VALUE` (repeatable, and the same on `restart`) passes extra environment variables to the project's dev script, so a dev server can be booted on a different configuration without editing `.dev3/config.local.json`. It overrides the project's own `env` but never the task's identity or its assigned `DEV3_PORT*`, and those names are refused outright rather than silently dropped. A bare `restart` reuses the last start's variables, a `stop` clears them, and `dev3 dev-server status` lists their names (never their values).
