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
`sandboxd` restart (136 probes, 0 denials). The launchd job does not: reproduced on 2026-11-08, once
the bundle the job's tmux came from was deleted, tccd logged `proc_pidpath_audittoken() failed from
PID[<server>]: (#2) No such file or directory` and `Failed to create attribution chain from message`,
and about 45 s later every pane lost `~/Desktop`, `~/Documents` and Full Disk Access. A bundle that was
only moved kept access. `lsof -a -p <pid> -d txt -Fikn` reports the server's current executable
(it follows a move, and keeps the old path once the file is deleted); `ps -o comm=` shows the stale argv.
An update puts the new bundle at the same path, so the path alone matches; the old file shows as
`k0` (no links left) with an inode that differs from what `stat` returns for that path now.

## Decision

`ensureLaunchdServer` (`src/bun/tmux/launchd-server.ts`) runs before the two server-starting client
calls (`TmuxClient.newSessionDetached`, `spawnAttachedSession`). On macOS with a bundled tmux, if the
socket has no server it writes a plist (`tmux -D -L <socket> -f <config>`, the environment the
client would have handed a self-started server, the app's `NumberOfFiles` limits, because launchd's
default soft limit of 256 would reach every pane, `ProcessType=Interactive`) into a fresh `mkdtemp`
directory with `wx`, bootstraps it into `gui/<uid>`, deletes the directory and waits up to 2 s for the
socket. The label hashes the full socket path, so instances with different `TMUX_TMPDIR`s never share
a job. A job that is still running when its socket does not answer (a deleted socket file) is never
booted out: it gets SIGUSR1, which makes tmux recreate the socket. Every `launchctl` call has a timeout. The job is not in
`~/Library/LaunchAgents`, so it never runs at login and leaves nothing to uninstall. A live or
unanswering server is never touched; any failure logs and lets tmux start its own server as before.
The binary is resolved through symlinks first, so the `~/.dev3.0/bin/tmux` shim counts as the bundle
it points at. `-D` turns tmux's `exit-empty` off; a `session-created` hook in the dev3 config
(`src/bun/tmux/config.ts`) turns it back on once a session exists, so the server still exits after
the last session closes. `predatesLaunchdServer` flags a live server launchd does not own, and the
renderer shows a one-time warning toast (`getTmuxServerNotice`) because such a server stays exposed
until it restarts. `staleServerBinary` compares the server's executable (from `lsof`) with this
bundle's tmux: `deleted` (access already lost: the file is gone, has no links, or its inode was
replaced) or `elsewhere` (another dev3 bundle, lost once it is deleted) replaces that toast with one
offering "Restart terminals", which confirms and then runs `restartTmuxServer` (`tmux.stopServer`,
which throws instead of reporting a restart that did not happen). `deleted` stays until acted on;
`elsewhere` times out, because two running copies legitimately share the `dev3` socket.

## Risks

- The grant inheritance is observed, not documented: Apple only promises that a launchd job is its own
  responsible process, not that tccd credits a binary inside `dev3.app` to the app's bundle id. If a
  macOS release stops doing that, terminals lose access with no fallback (the bootstrap still
  succeeds); re-check `ls ~/Documents` in a task terminal after major macOS updates.
- A server created by an older dev3 keeps the flaw until it restarts; the first update ships the
  fix without protecting terminals that are already open.
- Deleting the bundle a running launchd server came from (the Electrobun updater removes the old
  bundle, `brew upgrade`, a reinstall that drops the old copy) cuts access for every pane until the
  server restarts. The check runs once per launch, so a deletion while dev3 stays open is caught only
  at the next launch; restarting ends every running agent, so it is never automatic.
- Homebrew/PATH/custom tmux keep the old start: tccd would judge them as themselves and they would
  lose the access they inherit from a live app. The native backend's detached host has the same flaw.

## Alternatives considered

- **`responsibility_spawnattrs_setdisclaim`** — works, but a private API plus a shipped C launcher.
- **`SMAppService.agent`** — Apple's preferred path, but needs native code Electrobun does not expose
  and adds a Login Items entry.
- **Kill the server when the app quits** — loses the agents-survive-restart property.
- **Grant Full Disk Access to the tmux binary** (#1903's workaround) — broader than needed and manual.
