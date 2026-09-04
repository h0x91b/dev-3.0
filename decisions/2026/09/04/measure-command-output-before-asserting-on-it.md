# A fixture of real command output must be pasted from a real run

## Context

`src/bun/__tests__/terminal-e2e-guard.test.ts` asserted that a leaked tmux server
appears in `ps` as `tmux: server (/private/tmp/tmux-501/dev3-live-guarded-9911)`.
Nobody had run `ps` to check. That one hand-written string then propagated: it was
quoted as established fact in `decisions/2026/08/27/tmux-socket-liveness-by-connect-not-ps.md`,
and a first socket-sweep implementation built on it found zero live servers on a
machine that had six and proposed unlinking 1 343 socket files including the running
app's own — caught only by a dry run.

## Investigation

Measured 2026-09-04 against a live tmux server started through `TmuxClient`:

| Platform | command | output |
| --- | --- | --- |
| macOS 15, tmux 3.6 | `ps -Ao pid=,ppid=,command=` | `84620  1  tmux -L dev3-live-guarded-84602 -f … new-session -d …` |
| Ubuntu 24.04, tmux 3.4 | `ps -Ao pid=,ppid=,command=` | `  272  1  tmux -L dev3-live-guarded-42 new-session -d -s repro sleep 300` |
| Ubuntu 24.04, tmux 3.4 | `ps -Ao pid=,comm=` | `  272  tmux: server` |
| macOS 15, tmux 3.6 | `ps -Ao pid=,comm=` | `71459  /Applications/dev-3.0.app/…/tmux` |

The daemonised server (ppid 1) keeps the argv of the command that started it, socket
name included, on both platforms. The `tmux: server (<path>)` form appears in
`command=` on neither, and on Linux reaches `comm=` only, without the path.

The 2026-08-27 record's claim that a live server "appears as the single word `tmux`"
was a misattribution: a bare `tmux` line on that machine belonged to a server someone
had started by typing `tmux`, while the app's own server was one of the long
`-L dev3 …` lines read as a client. Confirmed by asking tmux itself —
`display-message -p '#{pid}'` on the live `dev3` socket returned pid 71459, whose `ps`
line is the full `-L dev3 …` argv. That record's decision (probe the socket, do not
parse `ps`) is unaffected and still right; only its reasoning was wrong.

## Decision

A test fixture standing in for the output of an external command — `ps`, `git`,
`lsof`, `tasklist`, a tmux `-F` line — is pasted from a real run of that command on
every platform the code runs on, with the command and the date recorded next to it. A
plausible-looking string written from memory is not a fixture; it is an assumption
wearing a fixture's clothes, and it survives review precisely because it looks right.

Applied in `src/bun/__tests__/terminal-e2e-guard.test.ts`:
`REAL_LEAKED_SERVER_MACOS`, `REAL_LEAKED_SERVER_LINUX` and `REAL_APP_SERVER` are
measured strings, and the two tests that carry the guard's claim about a leaked server
assert on them. The proctitle form is kept as an explicitly-labelled defensive
superset — it is what a platform with `setproctitle(3)` prints — and no longer stands
alone as evidence.

Where the shape of the output is the platform's choice rather than ours, the fixture
is a supplement to a check that does not depend on it. Hence
`liveTmuxServerSockets()`: a `connect()` to the socket answers "is a server alive"
without reading a process title at all.

This is one instance, not a pattern — a sweep for other hand-written fixtures of real
command output found no second case. It is written down because this one cost a wrong
decision record and nearly cost 1 343 files.

## Risks

- A measured fixture is a snapshot: a future tmux, or a platform not measured here
  (BSD, Windows), may print something else. The socket probe is what keeps the check
  working when that happens; the fixtures only keep the `ps` path honest.
- Recording the measurement command in a comment is a convention, enforced by review
  only. There is no test that can tell a measured string from an invented one.

## Alternatives considered

- **Delete the proctitle fixtures.** Rejected: matching that form costs nothing and is
  correct on platforms with `setproctitle(3)`. The defect was that it stood alone, not
  that it existed.
- **Generate the fixture by running `ps` inside the test.** Rejected: the unit suite
  would then depend on a live tmux server and on the machine's process table, which is
  what the gated `*.bun-e2e.ts` scripts are for.
- **Drop the `ps` path and rely on the socket probe alone.** Rejected: `ps` is the only
  check that sees a leaked tmux *client* or native host, which the socket cannot.
