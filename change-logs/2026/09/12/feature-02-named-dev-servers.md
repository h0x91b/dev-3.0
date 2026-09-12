Short: Several dev servers per task

A project can now declare any number of dev servers by name, each with its own script, ports, environment and working directory. A task starts, stops and restarts each one on its own — or all at once — from the task header, the Kanban card, or `dev3 dev-server start|stop|restart <name>` / `--all`. Every server gets its own pane and its own status, and every named port reaches every server of the task as `DEV3_PORT_<NAME>`, so the front end knows where the API is. An existing `devScript` keeps working untouched as the default server named `dev`.
