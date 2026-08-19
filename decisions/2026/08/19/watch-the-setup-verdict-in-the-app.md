# Watch the setup verdict in the launching app, never through the dev3 CLI

## Context

A project's `setupScript` runs inside the task pane, so bun never sees its exit
code. The pane's "start the agent anyway" card needs that code, which means the
wrapper has to report a failure back to the app somehow.

## Investigation

The first implementation had the wrapper write the code to
`setupExitCodePath(taskId)` and then shell out to `dev3 hook setup-failed`, a
CLI command whose socket handler read the file and updated the task. It was
green in unit tests and never fired once in real use. Two independent reasons,
both structural:

- **The CLI on disk belongs to whoever launched last.** Every app instance
  copies its own binary over `~/.dev3.0/bin/dev3` at startup — 16 times in one
  morning on this machine, alternating between `/Applications` and several dev
  worktree builds. `dev3CliExecutable()` returns exactly that path, so the
  wrapper invokes a build that may predate the command and answers
  `Unknown command: hook`.
- **The socket addresses any app, not the right one.** `discoverSocket()`
  (`src/cli/context.ts`) picks the newest live endpoint in `~/.dev3.0/sockets/`
  with no notion of which instance owns the task. With two apps running (the
  normal state on a dev machine) the ping lands in a coin-flip process, which
  answered `Unknown method: task.setupFailed` — swallowed by the command's
  deliberate silence, so nothing was logged anywhere.

Reproduced end to end from a worktree: the exit-code file was on disk holding
`1`, and no `Updating task` line for it existed in any instance's log.

## Decision

The wrapper only writes the file. `src/bun/setup-failure-watch.ts` polls that
path (1 s, one-shot, `unref`'d, 1 h leak stop) and `launchTaskPty` starts a
watch whenever it builds a setup wrapper, stopping any previous one first. The
process that started the launch is the only one that can act on the verdict and
already holds the task and the push channel, so nothing needs addressing.
`dev3 hook setup-failed` and the `task.setupFailed` socket method are deleted.

Polling rather than `fs.watch`: the file does not exist when the watch begins,
and watching its directory means watching the whole temp root.

## Risks

One 1 s timer per launching task, and a failure arriving after an hour is
missed. Both are cheap next to a channel that silently never fires. A crashed
app loses the verdict — but it has also lost the pane the card would live in.

## Alternatives considered

- **Keep the CLI, hand it the launching instance's socket and its own bundled
  binary.** Fixes both faults but keeps five links (PATH, shell dialect,
  quoting, socket, version) where one was enough to fail invisibly.
- **Parse a sentinel line out of the PTY stream.** No new mechanism, but it
  makes terminal output load-bearing and breaks on rewraps and colour codes.
