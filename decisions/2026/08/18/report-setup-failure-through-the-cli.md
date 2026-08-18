# Report a failed setupScript back through the CLI, not through the pane's output

## Context

`setupScript` runs inside the task's terminal pane, written into a generated
wrapper script (`buildSetupStartupWrapper`, `src/bun/rpc-handlers/shared-pure.ts`).
The wrapper's fail branch printed `✗ Setup failed (exit N)` and `exec`-ed an
interactive shell. `exec` never returns, so in `blocking` launch mode and on the
native backend — where the agent is started *after* the setup script — the agent
was never launched at all. The pane held a healthy shell, so nothing in the app
looked broken; the user just lost every route back to the task's prompt.

## Investigation

bun cannot observe the script's exit code: it spawns tmux (or the native host),
not the script. Three channels were considered. Scraping the pane's output for a
marker is what the terminal layer already refuses to do elsewhere and breaks on
any user script that prints the same text. Polling a sentinel file costs a timer
per launch for an event that is rare. The CLI socket is the channel hooks already
use (`dev3 hook codex`, `dev3 hook claude-stop-failure`), and the wrapper runs in
the worktree, so `dev3` resolves its own task from cwd.

## Decision

The fail branch writes the exit code with `writeExitCodeFile` — the dialect
helper that already handles PowerShell 5.1's UTF-16LE `>` — to
`setupExitCodePath(taskId)` (`src/bun/temp-paths.ts`), then calls
`dev3 hook setup-failed`, guarded by `ifCommandExists`. The CLI command
(`src/cli/commands/setup-failed.ts`) is silent and always successful. The socket
method `task.setupFailed` reads the file and stores `Task.setupFailedExitCode`,
which `TaskTerminal` renders as a card over the pane: *Start agent anyway* (an
ordinary `restartTask`, which relaunches with `runSetup = false`) or *Show setup
log*. Every launch clears the field first, so the card re-arms.

The exit code travels in a file rather than as an argv value because
interpolating a shell variable into a quoted argv differs per dialect, while the
file writer is already dialect-correct.

## Risks

A `dev3` that is missing, offline, or slow means no card — the user still gets
the log and the printed exit code, which is exactly today's behaviour. The
recorded code can be stale if a write fails mid-launch; launches delete the file
up front, and a missing or zero value is stored as `1` rather than trusted.

## Alternatives considered

Launching the agent automatically on failure was rejected: it makes `blocking`
mean nothing, and an agent facing a half-installed tree is often worse than no
agent. A modal was rejected because this failure arrives in batches — one bad
registry flip fails every task started after it, and each would stack its own
modal over whatever the user was reading. See the UX plan in the PR.
