# Start the macOS tmux server as a launchd job

## Context

Task terminals on macOS lost `~/Documents`, `~/Desktop` and Full Disk Access at random, hours after
an app restart or update, while every grant in the TCC database still read "allowed". Every denied
process descended from one tmux server that had daemonized out of a dev3 instance that no longer
existed. `decisions/2026/10/03/doctor-probes-repo-access-from-the-terminal.md` left the cause open.

## Investigation

Caught live on 2026-10-25: when `sandboxd` respawned (dropping its cached verdicts), its requests for
`kTCCServiceSystemPolicyAllFiles` and `...DocumentsFolder` failed with `Failed to create Attribution
Chain from message`, and the kernel denied `file-read-data` for every pane process. A tmux server
spawned with responsibility disclaimed, and one run as a `launchctl bootstrap` job, were both logged
by tccd as `responsible_path=<dev3.app>/Contents/Resources/app/tmux/tmux`,
`AUTHREQ_SUBJECT=dev3.electrobun.dev`: the existing app grants applied, with no prompt and no live
app. A disclaimed server whose bundle was swapped and the original deleted kept access across a
`sandboxd` restart (136 probes, 0 denials).

## Decision

`ensureLaunchdServer` (`src/bun/tmux/launchd-server.ts`) runs before the two server-starting client
calls (`TmuxClient.newSessionDetached`, `spawnAttachedSession`). On macOS with a bundled tmux, if the
socket has no server it writes a 0600 plist (`tmux -D -L <socket> -f <config>`, the environment the
client would have handed a self-started server, `ProcessType=Interactive`), bootstraps it into
`gui/<uid>`, deletes the file and waits up to 2 s for the socket. The job is not in
`~/Library/LaunchAgents`, so it never runs at login and leaves nothing to uninstall. A live or
unanswering server is never touched; any failure logs and lets tmux start its own server as before.
The binary is resolved through symlinks first, so the `~/.dev3.0/bin/tmux` shim counts as the bundle
it points at. `-D` turns tmux's `exit-empty` off; a `session-created` hook in the dev3 config
(`src/bun/tmux/config.ts`) turns it back on once a session exists, so the server still exits after
the last session closes. `predatesLaunchdServer` flags a live server launchd does not own, and the
renderer shows a one-time warning toast (`getTmuxServerNotice`) because such a server stays exposed
until it restarts.

## Risks

- A server created by an older dev3 keeps the flaw until it restarts; the first update ships the
  fix without protecting terminals that are already open.
- An update that changes the tmux binary's code was not verified, only a byte-identical swap.
- Homebrew/PATH/custom tmux keep the old start: tccd would judge them as themselves and they would
  lose the access they inherit from a live app. The native backend's detached host has the same flaw.

## Alternatives considered

- **`responsibility_spawnattrs_setdisclaim`** — works, but a private API plus a shipped C launcher.
- **`SMAppService.agent`** — Apple's preferred path, but needs native code Electrobun does not expose
  and adds a Login Items entry.
- **Kill the server when the app quits** — loses the agents-survive-restart property.
- **Grant Full Disk Access to the tmux binary** (#1903's workaround) — broader than needed and manual.
