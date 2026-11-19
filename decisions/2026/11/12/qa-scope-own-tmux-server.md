# A scoped QA instance runs its own tmux server

## Context

`scoped-qa-app-instance` redirected `DEV3_HOME` and left the tmux socket directory shared as a follow-up. A scoped instance therefore created its task sessions on the real app's `dev3` server. In a QA run, a `tmux split-window` against that server opened a pane in the agent's own real worktree, and the `dev3` CLI there, detecting its task from the cwd, sent a completion request to the real app.

## Decision

`qaScopeEnv` (`scripts/qa-scope.ts`) also sets `TMUX_TMPDIR` to `<scoped root>/t`, and `seedQaScope` creates it, because tmux creates only its own `tmux-<uid>` directory. The app reaches tmux only through spawns that inherit the process env, and a relaunch already forwards `TMUX_TMPDIR` (`launch-location.ts`), so every tmux call in the instance agrees on the server. `socket-files.ts` already resolves the socket directory through `TMUX_TMPDIR`, so the socket sweep follows.

A separate server needs an owner, because nothing in the app ever stops one. `scripts/dev.ts` calls `stopQaScopeTmux` on every exit path: it runs `kill-server` against each socket in `<scoped root>/t/tmux-<uid>/`, a directory nothing but this scope uses, with the scoped app's own tmux shim when one exists so the client and server versions match. The printed reset hint runs `kill-server` before `rm -rf`.

## Risks

The macOS socket path limit is 104 bytes; `t` keeps a typical `os.tmpdir()` path near 95, which a test pins. A developer who drives a QA session by hand must prefix the same `TMUX_TMPDIR`, as the `debug-ui` skill now says.

A server can still be orphaned: when `dev.ts` itself is SIGKILLed, or when someone deletes the scoped root without the hint's `kill-server`. Its sockets are then gone, so the server and every process in its panes keep running with no way to reach them, and the next run starts a second server. Stopping the dev server also ends the scoped sessions, unlike the real app, whose sessions outlive a restart; a QA board has nothing worth keeping across one.

## Alternatives considered

A distinct `-L` socket name for QA: every call site composes its socket from task data, so a name would have to be threaded through all of them, while the env reaches them for free.
