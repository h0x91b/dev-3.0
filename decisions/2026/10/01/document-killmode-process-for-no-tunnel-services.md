# Document KillMode=process as an opt-in drop-in for --no-tunnel services

## Context
`dev3 remote install-service` writes a unit with systemd's default `KillMode=control-group`. The tmux server that hosts every agent terminal is started by dev3 and lives in the unit's cgroup, so any stop or restart of the unit kills every running agent. Self-update avoids that by waiting for a quiet window, but a manual `systemctl --user restart` does not.

## Decision
The unit stays as it is. `docs/remote-access.md` (Run it as a service) documents an optional drop-in with `KillMode=process` for services started with `--no-tunnel`, and the WSL walkthrough in `docs/install.md` uses it and links there. `decisions/2026/09/20/headless-update-safety-boundaries.md` rejected `KillMode=process` as a default for every install; that still holds, and this is not a default.

## Risks
With the tunnel on, a supervised restart (`prepareHandoff` in `self-update.ts` assumes the tunnel dies with the unit) leaves the old `cloudflared` alive and serving the old public URL, and the successor starts a second one. The docs scope the drop-in to `--no-tunnel` for that reason. systemd logs the surviving processes as "left-over" at each start. Stopping or uninstalling the service no longer stops the agents either; the docs name `systemctl --user kill` for taking the whole cgroup down.

## Alternatives considered
- Ship `KillMode=process` in the generated unit: rejected upstream for changing cleanup for every install, containers included.
- Move the tmux server out of the unit's cgroup (for example `systemd-run --user --scope`): fixes the root cause for tunnel users too, but is a code change with its own lifecycle questions; out of scope for a docs change.
- Keep the advice fork-only: leaves upstream WSL and SSH users losing agents on every restart with no documented way out.
