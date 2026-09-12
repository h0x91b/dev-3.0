# Several named dev servers per task

## Context

A project had exactly one `devScript`, so a task could run exactly one dev server. Real
applications are several processes — a web front, an API, a back office, a worker. Users either
crammed them into one shell line (all-or-nothing, one log stream, one stop button that kills
everything) or started the extras by hand in a pane dev3 knew nothing about: no port link, no
status, no teardown on completion or hibernation.

A project now declares any number of dev servers by name in `devServers`, each with its own
script, session, pane, status and ports.

## Investigation

Two constraints shaped the design more than the feature itself.

`~/.dev3.0/` is shared with every other installed version of dev3 (AGENTS.md, "On-disk data
layout"), and `.dev3/config.json` lives in other people's repositories. Both are read by processes
this change cannot update.

The port pool reallocated whenever the requested count differed from the stored one. A task's port
count now grows every time a server declares a named port, so the old behaviour would have moved
`DEV3_PORT0` out from under a server already bound to it.

## Decision

- **`devScript` is not migrated — ever.** It stays a required string on `Project` and in
  `Dev3RepoConfig`, and it *denotes* the server named `dev`. `devServers.dev` is legal only when
  `devScript` is empty; declaring both is a config error surfaced in `DevServerStatus.configErrors`,
  never a silent merge. Nothing rewrites one into the other on load or on save. This is a deliberate
  exception to the repo's no-deprecation rule, which loses to the N-2 on-disk invariant.
- **The default server keeps its session name.** `dev3-dev-<short>` for `dev`, `dev3-dev-<short>-<name>`
  for the rest (`src/bun/tmux/session-names.ts`). An older dev3 running beside this one still finds,
  shows and tears down the default server exactly as before.
- **One resolver, `src/shared/dev-servers.ts`.** `resolveDevServers` turns a resolved project into the
  ordered server list, the task's named ports and the config errors; `resolveDevServerRef` decides what
  an unnamed command means (default → single → refuse). The backend, the CLI bridge and the renderer
  all read it, so they cannot disagree about what is declared.
- **Allocation extends, never reallocates** (`src/bun/port-pool.ts`). A grown count keeps the ports
  already handed out and picks only the tail; a shrunk one keeps the first N. `DEV3_PORT0..N` and
  `DEV3_PORT_COUNT` still describe the positional block alone, and named ports travel separately as
  `DEV3_PORT_<NAME>` — delivered to every server of the task, which is the point.
- **Per-server state is keyed by task *and* server**: the generated wrapper script, the extra-env
  store, the pre-start port snapshot, the viewer pane id. `killDevServerSession` takes the list of
  servers to stop, collects the survivors' pids first and excludes them from the orphan-port sweep,
  and waits only on the stopped servers' own ports.
- **The self-hosting guard compares both.** The wrapper exports `DEV3_DEV_SERVER=<name>`, so an
  instance hosted by the front end can stop the API without the deferred-teardown dance.

## Risks

A teardown with no explicit server list now discovers live servers from tmux. Discovery can come back
empty when the listing itself failed, so the default server is always included unconditionally — a
kill of a session that is already gone is a no-op, a task torn down with its server still running is
not.

Two dev3 versions acting on the same task at the same moment can still disagree about the port count:
the older one asks for `portCount` ports and truncates the assignment the newer one extended. Accepted
as rare; the extend-not-reallocate change removes it for a single version.

The CLI's positional argument now means either a task id or a server name. The two vocabularies barely
overlap (a task ref is `seq:<N>`, a UUID or a hex prefix; a server name is lowercase letters, digits
and dashes), and `--server` settles a name that is also hex.

## Alternatives considered

**Migrate `devScript` into `devServers.dev` on load.** One shape instead of two, and the editor would
not need a fixed first row. Rejected: it rewrites files other installs and other people's repositories
read, which the on-disk invariant forbids outright.

**A `--server` flag only, no positional name.** Unambiguous, and no task-ref heuristic. Rejected as
too noisy for the command agents type most (`dev3 dev-server start api` reads as the thing it does);
the flag stays for the ambiguous case.

**One pane per task with a split inside it, instead of one pane per server.** Fewer panes, but the
stop of one server would have to re-split the survivors, and the native backend has no nested split of
its own. One auxiliary pane per server keeps the two backends symmetric.
