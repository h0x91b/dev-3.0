Short: Pass arguments to dev-server scripts

`dev3 dev-server start|restart [server] -- <args...>` appends the arguments to the server's script, each shell-quoted; `restart` reuses them, and `status` and the dev-server menu show them. `dev3 dev-server` also now honours `--task <id>` on start, stop, restart, status and logs instead of silently acting on the task the shell is in, and rejects a `--task` that contradicts a positional task id.

Contributed by @diverru (h0x91b/dev-3.0#2048)
