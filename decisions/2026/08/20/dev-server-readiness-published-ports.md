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

Two rules keep that classification honest, both in `classifyAgainstStartSnapshot`
— the single entry point both the status handler and the port poller use:

- **No snapshot means nothing was published.** Only a start recorded by *this*
  process can have published anything, so a task with no snapshot (the app
  restarted under a surviving dev session) reports every foreign holder as a
  conflict. Treating a missing snapshot as an empty pre-start list would relabel
  any squatter "published" after every app restart and silently drop its WARNING.
- **A published holder is forgiven once, across the stop.** The container the
  devScript published to outlives its own stop — `tmux kill-session` HUPs
  `docker compose up` and the reaper SIGKILLs it 1.5s later, so the runtime keeps
  the container and its daemon keeps the port. Whatever was classified published
  is remembered per task (`carriedPublished`, survives `clearDevServerStart`) and
  filtered out of the next start's pre-start holders by exact `(port, pid)`.
  Without it the *first* start of a containerised project succeeds and every
  `restart --wait` afterwards fails on the port its own previous run published.

## Risks

A foreign process that starts squatting an assigned port *after* the dev server
launched is now read as "published for it", so `--wait` can report ready on a
port the devScript never bound. That is indistinguishable from the container
case without a project-declared probe, and a false ready is far cheaper than a
readiness check that can never pass. Carrying the verdict across a stop extends
that same false-ready one run further: a container left over from the previous
run makes `restart --wait` return ready while it is still serving the old build
until the devScript re-creates it — a port is never a build-freshness signal,
which is what the rejected `readyUrl` alternative would add. Both maps are
in-memory: after an app restart a surviving dev session has no snapshot, so its
published port drops out of the UI badge and back into the WARNING list until the
next start — never the reverse. A container started outside dev3 *before* the
first start of that dev server is still a pre-start holder with nothing carried,
so it reads as a conflict; that case genuinely cannot be told from a squatter.

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
