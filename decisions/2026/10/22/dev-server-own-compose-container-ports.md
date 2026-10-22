# A worktree's own compose container is not a pre-start squatter

## Context

`dev-server-readiness-published-ports` tells "published for this dev server" from
"squatter" by an exact `(port, pid)` pre-start snapshot. Docker Desktop publishes
every port under one long-lived `com.docker.backend` PID (Linux: `docker-proxy`),
so the previous run's container and the new one look identical. Whenever that
container is still up when the snapshot is taken, the port is recorded as a
squatter and `--wait` times out on a healthy stack.

## Investigation

No commit changed the classifier's logic since #1429; #1754 only keyed the
snapshot per server and #1990 moved the code verbatim. On HUP `docker compose up`
stops its container, but that takes up to Docker's 10s grace, and teardown did not
wait for foreign-held ports, so the 250ms restart gap snapshots the old container.
The in-memory `carriedPublished` forgives it only within one app process, so after
an app restart every later restart is poisoned again.

## Decision

`findWorktreeContainerPorts` (`src/bun/container-ports.ts`) asks `docker ps` for
the host ports of running containers whose `com.docker.compose.project.working_dir`
is the worktree (raw or realpath) or a folder inside it. It runs only when an
assigned port already has a foreign holder:

- `killDevServerSession` waits up to 15s for those ports to free, like ports the
  tree held. Skipping that wait made `restart --wait` report the stopping old
  container as the new one ready.
- `startOneDevServer` drops those holders from the pre-start snapshot, for a
  container that outlives the stop (`up -d`). Status, `--wait`, the board poller
  and the teardown carry all read that snapshot, so they agree.

## Risks

A compose project's stop or restart can now take up to ~10s longer: the time
Docker really spends stopping the container. A container that survives the stop
still reads as ready at once, as `carriedPublished` already did. Falls back to the
old behaviour (a conflict): a plain `docker run`, a compose working dir outside
the worktree (`-f ../x`), podman (no `.Label` template), Windows paths, a remote
`DOCKER_HOST`. A hung Docker CLI is bounded by a 5s probe timeout.

## Alternatives considered

- **Trust any container runtime daemon as published** — loses the "another
  project's container on our port" conflict.
- **Persist `carriedPublished` to disk** — still fails on the first start after a
  container was left running, and adds on-disk state.
- **Only exempt at start, no stop wait** — `--wait` returns while the old
  container is still serving.
