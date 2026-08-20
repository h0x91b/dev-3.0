# Dev-server readiness accepts ports published by another process

## Context

`dev3 dev-server start --wait` polled `devServer.status` until `devPorts` was
non-empty, and `devPorts` came from socket *ownership*: the listening PID had to
be inside the dev-server pane's process tree. A containerised `devScript`
(`docker compose up`, Colima, OrbStack, podman) can never satisfy that — the
container runtime's daemon publishes the port, so the listener is
`com.docker.backend`, never a descendant of the pane. `--wait` burned the whole
timeout on a healthy stack, `Detected Ports` said `(none detected)`, and the
normal state was printed as a `WARNING: port … not owned by this dev server`
(issue #1427). No `devScript` shape can fix it from the project side.

## Investigation

The reporter's `lsof` output confirmed the listener is the Docker daemon while
the pane tree only holds `bash` + `docker compose`. The ownership check is
therefore structurally unsatisfiable for every container runtime, not a
misconfiguration.

## Decision

Ownership stays the primary signal; a second class is added next to it. On every
dev-server start `recordDevServerStart` (`src/bun/dev-server-ports.ts`) snapshots
the assigned pool ports and who was already listening on them. Afterwards,
`classifyAssignedPortOwners` splits foreign holders of those ports in two: a
holder present in the pre-start snapshot is a squatter (`portConflicts`, still a
WARNING), a holder that appeared later was published for this dev server
(`publishedPorts`, new field on `DevServerStatus`). `--wait` treats
`devPorts ∪ publishedPorts` as ready (`src/cli/commands/dev-server.ts`), status
prints a `Published Ports:` line, the port poller merges published ports into the
task's port list so the UI badge sees them, and a wait that does time out names
the squatting process instead of only guessing "build still in progress?".

## Risks

A foreign process that starts squatting an assigned port *after* the dev server
launched is now read as "published for it", so `--wait` can report ready on a
port the devScript never bound. That is indistinguishable from the container
case without a project-declared probe, and a false ready is far cheaper than a
readiness check that can never pass. The snapshot is in-memory: after an app
restart a surviving dev session has none, so its published port drops out of the
UI badge until the next start — never the reverse.

## Alternatives considered

- **`readyUrl` / `readyCommand` in `.dev3/config.json`** (the reporter's first
  choice) — strictly better semantics and also covers "port open before the app
  can serve", but it adds public config surface the user curates; worth doing on
  top of this, not instead of it.
- **Accept any TCP connect to the assigned port while the dev server lives** —
  simplest, but it silently swallows real squatters, which is the case the
  ownership check was added for.
- **Fail fast when the port is held by a foreign process** — rejected as the
  primary behaviour: with several assigned ports a squatter on one of them would
  abort a wait that was about to succeed on another. Kept only as the diagnosis
  attached to the timeout error.
