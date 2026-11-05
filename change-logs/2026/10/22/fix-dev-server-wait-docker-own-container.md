Short: dev-server --wait sees Docker ports

`dev3 dev-server start/restart --wait` and the status warning now treat a port published by this task's own docker compose container as the dev server's port, and a stop waits for that container to release it so a restart is not reported ready on the old one; a container from another compose project on that port is still reported as a conflict.

Contributed by @diverru (h0x91b/dev-3.0#2044)
