Short: Clear a dev server's remembered env

`dev3 dev-server restart --clear-env` restarts a dev server without the `--env` variables it was last started with, instead of needing a stop and a fresh start. The remembered env file and the generated dev-server script that carry those values are now owner-only, so a token passed with `--env` is no longer readable by other users of the machine, and `dev3 dev-server start --wait api` now starts `api` rather than the default server.
