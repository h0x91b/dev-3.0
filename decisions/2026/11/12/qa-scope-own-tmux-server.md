# A scoped QA instance runs its own tmux server

## Context

`scoped-qa-app-instance` redirected `DEV3_HOME` and left the tmux socket directory shared as a follow-up. A scoped instance therefore created its task sessions on the real app's `dev3` server. In a QA run, a `tmux split-window` against that server opened a pane in the agent's own real worktree, and the `dev3` CLI there, detecting its task from the cwd, sent a completion request to the real app.

## Decision

`qaScopeEnv` (`scripts/qa-scope.ts`) also sets `TMUX_TMPDIR` to `<scoped root>/t`, and `seedQaScope` creates it, because tmux creates only its own `tmux-<uid>` directory. The app reaches tmux only through spawns that inherit the process env, and a relaunch already forwards `TMUX_TMPDIR` (`launch-location.ts`), so every tmux call in the instance agrees on the server. `socket-files.ts` already resolves the socket directory through `TMUX_TMPDIR`, so the socket sweep follows.

## Risks

The macOS socket path limit is 104 bytes; `t` keeps a typical `os.tmpdir()` path near 95, which a test pins. A developer who drives a QA session by hand must prefix the same `TMUX_TMPDIR`, as the `debug-ui` skill now says.

## Alternatives considered

A distinct `-L` socket name for QA: every call site composes its socket from task data, so a name would have to be threaded through all of them, while the env reaches them for free.
