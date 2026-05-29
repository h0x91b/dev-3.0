# 056 — Pass per-task env vars to tmux via `-e KEY=VAL` on new-session / split-window

## Context

A bug report described `DEV3_TASK_ID` leaking between tasks: a setup
script in task B would build a docker container whose name was derived
from `$DEV3_TASK_ID`, but the container ended up named after task A and
mounted against task A's worktree.

Root cause: `tmux new-session` was spawned through `Bun.spawn` with the
correct env in the *child process*, but tmux's **server** inherits its
global environment only from whichever client started it first. Every
subsequent `new-session` (and any later `split-window` / `new-window`
inside an existing session) reads variables not listed in
`update-environment` from the server's frozen global env — so all tasks
saw `DEV3_TASK_ID` from the first task that booted the server.

The existing safety-net (a `setTimeout(200, () => set-environment …)`)
ran late, fire-and-forget, and could not close the race for anything
that ran during those 200 ms.

## Decision

Set per-session environment **atomically at session creation** by
passing `-e KEY=VAL` flags directly to every tmux entrypoint that
creates a new session, window, or pane on behalf of dev-3.0:

- `pty-server.ts` → `tmux new-session -A -e DEV3_TASK_ID=… -e DEV3_WORKTREE_ROOT=…`
- `rpc-handlers/task-lifecycle.ts` → cleanup `new-session` carries all `DEV3_*` lifecycle vars
- `rpc-handlers/tmux-pty.ts`:
  - `launchColumnAgent` `split-window`
  - `runDevServer` `new-session -d` (dev server) and viewer `split-window`
  - `spawnAgentInTask` `split-window`

The post-spawn `set-environment` loop stays as a safety net for the
`-A` (attach-existing) path, where `-e` flags on `new-session` are
ignored. Splits/windows opened later inside a session inherit from
session-environment, so they need no extra wiring.

## Risks

- `-e KEY=VAL` requires tmux 2.7+ (released 2018). Lower versions would
  reject the flag. The requirements check already enforces a recent
  tmux; treat this as part of that contract.
- Values containing newlines or `=` are passed through as-is. tmux
  treats `KEY=VAL` as opaque, so `=` inside `VAL` is fine. Newlines in
  env values would already corrupt the tmux argv — out of scope.

## Alternatives considered

- **Add `DEV3_TASK_ID` to `update-environment`.** tmux would then copy
  the var from the *current client* into new sessions. Works for new
  sessions but doesn't help inside an existing session (splits/windows
  read from session-environment, not client env). Rejected.
- **Set the variable globally with `tmux set-environment -g`.** This
  would pollute the server global with a single task's id and just
  move the leak elsewhere. Rejected.
- **Keep the `setTimeout` and remove `-e`.** The 200 ms window is a
  real race; any setup script touching `$DEV3_TASK_ID` during boot
  could see the leaked value. Rejected.
