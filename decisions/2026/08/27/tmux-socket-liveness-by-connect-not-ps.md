# Dead tmux sockets are detected by connecting to them, not by reading `ps`

## Context

tmux leaves its socket FILE on disk when the server dies, and `kill-server` does
not unlink it. Every dev3 test that mints a pid-keyed socket name
(`dev3-live-test-<pid>`, `dev3-seam-<pid>`, …) therefore added one file that
nothing ever removed. Measured on the maintainer's machine on 2026-08-27:
**1 413 socket files in `/tmp/tmux-501` behind 6 live servers**, growing by one
per e2e run. No observed harm — tmux unlinks a stale socket and starts fresh —
so this is hygiene, not an incident.

Fixing it needs one dangerous question answered correctly: *is anything still
using this socket?* Getting it wrong deletes the socket of the app's own running
tmux server.

## Investigation

The obvious check is the process table: a tmux server advertises its socket in
its process title, `tmux: server (/private/tmp/tmux-501/dev3-live-guarded-42)`.
The fixtures in `src/bun/__tests__/terminal-e2e-guard.test.ts` assert exactly
that string, so it reads as established fact.

**It is not true on macOS.** Measured with `ps -Ao pid=,command=` against a live
54-session dev3 server: that server appears as the single word `tmux`, with no
socket path anywhere in the output. tmux clients do show their `-L <name>` argv;
servers do not. A first implementation built on this parsed the real process
table, found **zero** live servers, and proposed deleting 1 343 files including
the socket of the running app — caught only by a dry run before anything was
unlinked. The guard's own fixtures were synthetic, and a comment is not evidence.

A `connect()` to the unix socket answers the question directly and needs no
process table at all. Verified both directions: the live `dev3` socket connects
(and still had all 54 sessions afterwards), and real leftover files answer
`ENOENT`.

## Decision

`src/bun/tmux/socket-files.ts` holds the socket-directory resolution
(`$TMUX_TMPDIR` else `/tmp`, plus `tmux-<uid>` — mirroring tmux's `make_label()`),
`removeTmuxSocketFile`, and the pure sweep decision `selectSweepableSockets`.
`src/bun/tmux/socket-sweep.ts` holds the IO shell: `probeSocketLiveness` (a
bounded `net.connect`, where `ENOENT`/`ECONNREFUSED` means dead and anything else
means `unknown`) and `sweepDeadTmuxSockets`, wired into startup in
`src/bun/index.ts` next to `sweepStaleWorktreeTrust`.

Five conditions must all hold before a file is unlinked: `dev3-` prefix, owned by
our uid, actually a socket, older than one minute, and nothing listening.
`unknown` liveness keeps the file. `TmuxClient.killServer()` kills the server and
unlinks the socket in one call, and every e2e script that mints a pid-keyed
socket calls it.

The split into two files is load-bearing: `socket-files.ts` imports only
`node:fs`/`node:path`, so a renderer test can use the unlink helper without
pulling in the logger or `tmux/binary.ts`'s module-load side effects.

## Risks

- A socket whose server is mid-bind could read as dead. The one-minute age gate
  covers it, and the app's own long-lived `dev3` socket is additionally outside
  the `dev3-` prefix.
- pid reuse could put a live server on a name we consider stale; the connect
  probe answers per-file at sweep time, so this is exactly what it rules out.
- The probe opens and immediately drops a connection on a live tmux server. tmux
  handles that the same way it handles a crashed client; verified against a live
  54-session server with no session loss.
- `terminal-e2e-guard.ts` still cannot see a leaked tmux SERVER on macOS, for the
  reason above. Not changed here — it catches tmux clients, and widening it is a
  separate question.

## Alternatives considered

- **`ps` parsing** — measured wrong on macOS; see above.
- **`lsof -U`** — exact, but seconds of runtime and an extra external binary for
  a startup path.
- **`tmux -L <name> has-session`** — tmux starts a server for most commands, so
  probing 1 400 sockets would spawn servers rather than find them.
- **Age alone (delete anything older than N days)** — cannot distinguish a live
  long-running server from garbage, which is the whole problem.
