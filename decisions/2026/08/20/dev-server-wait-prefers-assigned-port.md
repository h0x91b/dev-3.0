# `--wait` prefers the assigned port, with a grace window before it settles

## Context

`waitForDevServerReady` returned as soon as *any* port counted as ready — its own
docstring said "at least one port". `devPorts` is every port held by any pid in
the dev-server process tree, so a bundler's HMR socket or a sidecar satisfied the
wait while the pool-assigned `DEV3_PORT0` came up seconds later. The agent
protocol tells agents to `--wait` and then curl `$DEV3_PORT0`, so that curl
failed and every agent had to hand-roll a retry loop. The readiness rework in
`dev-server-readiness-published-ports.md` (#1429) changed *which* ports count
(ownership vs published) but not *which* port matters, so the race survived it.

## Decision

`--wait` now ends immediately only on a port in `status.assignedPorts`
(`src/cli/commands/dev-server.ts`, `waitForDevServerReady`). When some other port
is up but no assigned one is, it records the moment and keeps polling for
`WAIT_ASSIGNED_GRACE_MS` (10s), printing one line so the extra wait is visible.
When the window expires — or the overall `--timeout` would fire first — it
reports ready on what is listening and says the assigned ports never came up. A
task with no assigned ports keeps the old any-port behaviour verbatim.

## Risks

The grace window costs a project whose `devScript` binds a fixed port and ignores
`$DEV3_PORT0` an extra 10s on every `--wait`; it is bounded and the message tells
the user why. A dev server that binds its assigned port before it can actually
serve is still a false ready — a port is not an application-level probe, which is
what the `readyUrl` alternative in the #1429 record would add. Any assigned port
counts, not `DEV3_PORT0` specifically: requiring all of them would hang every
project that reserves three ports and binds one.

## Alternatives considered

- **Hard-require an assigned port, error on timeout** with a `--wait-any` escape
  hatch — honest semantics, but it turns a working flow into a 120s timeout for
  fixed-port projects until they read the error.
- **A separate `--wait-assigned` flag** — zero regression, but the agent protocol
  would just point at the new flag, making it the de-facto default the long way
  round while leaving the plain `--wait` trap in place for everyone else.
