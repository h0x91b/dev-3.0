# 047 — Propagate auth env vars to every tmux session

## Context

Users reported `git fetch` (and other git-over-SSH operations) intermittently
hanging inside dev3 terminals. The hang is the classic symptom of `ssh` failing
to reach an ssh-agent: it falls back to interactive passphrase entry, which
blocks forever on a non-interactive pane.

## Investigation

The app already resolves `SSH_AUTH_SOCK` (and PATH/LANG/etc.) from the user's
login shell at startup (`src/bun/shell-env.ts`, `src/bun/index.ts`). That value
is patched onto `process.env`, and `src/bun/spawn.ts` merges `process.env` into
every child process — so the initial tmux client receives a correct
`SSH_AUTH_SOCK`.

The gap is in tmux's environment model:
- The tmux server keeps its own *global environment*, captured when it starts.
- The dev3 server (`tmux -L dev3`) is long-lived and persists across app
  restarts.
- New sessions inherit env from the server's global env, not from the spawning
  client.
- `update-environment` copies vars from client env to session env only on
  client attach (and reportedly at session creation), but only for whitelisted
  keys. Detached sessions (`new-session -d` for the dev server) never trigger
  this.
- Existing pane spawns (`split-window` for git ops, dev server viewer, column
  agents, `spawnAgentInTask`) inherit *session env*, not client env. If the
  session env was seeded from a stale tmux server, every new pane gets stale
  auth vars.

Result: a user who launched the app once without `SSH_AUTH_SOCK` (or with a
shell that didn't export it) gets a tmux server that holds onto that broken
env, and every subsequent split-window pane suffers.

## Decision

Explicitly propagate auth-related env vars from `process.env` onto each tmux
session immediately after creation, instead of relying on tmux's implicit env
inheritance.

Implementation:
- `src/bun/pty-server.ts` exports `AUTH_ENV_KEYS`, `getAuthEnv()`, and
  `propagateAuthEnvToTmux(socket, sessionName)`. The helper runs
  `tmux set-environment -t <session> <key> <value>` for every var in
  `process.env` that matches the whitelist.
- `spawnPty` calls it inside the post-creation `setTimeout` block, alongside
  the existing `configureTmux` step.
- `runDevServer` (`src/bun/rpc-handlers/tmux-pty.ts`) calls it right after
  `new-session -d` so the detached dev-server session is seeded too.
- `runCleanupScript` (`src/bun/rpc-handlers/task-lifecycle.ts`) prepends
  `export <key>=<value>` lines for every auth var to the cleanup script
  before writing it to disk. The cleanup pane's command starts immediately, so
  there's no window in which we could call `set-environment` first.
- The bundled tmux config (`TMUX_CONFIG_FUNCTIONAL`) lists all keys in
  `update-environment` as a belt-and-suspenders fallback for future spawn
  paths.

Vars propagated: `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `SSH_CONNECTION`,
`SSH_CLIENT`, `SSH_TTY`, `DISPLAY`, `GPG_AGENT_INFO`, `GPG_TTY`.

## Risks

- `process.env.SSH_AUTH_SOCK` still depends on the startup shell probe in
  `resolveShellEnv` succeeding. Users with unsupported shells (fish, nu) where
  the probe returns `{}` fall back to whatever env the .app inherited at
  launch, which on macOS-from-Finder may still be empty. Out of scope for this
  fix.
- We unconditionally overwrite the tmux session env on every `spawnPty` /
  `runDevServer` call. If a user manually `tmux set-environment`'d a custom
  value for one of these keys, it'll be replaced on the next session restart.
  Acceptable: these are all auth-related and should track the host shell.

## Alternatives considered

- **Kill the dev3 tmux server on app start.** Cleanest in theory, but risky:
  users may have running tasks attached to the server, and killing it would
  destroy their work.
- **Rely solely on `update-environment`.** Insufficient for detached sessions
  (`new-session -d`) and for the case where the tmux server's stored config
  doesn't match the bundled one (subsequent `-f` is ignored once the server is
  up).
- **Pass env explicitly per-pane on `split-window`.** Tmux has no
  `--env` flag for split-window; we'd have to wrap every command in a shell
  with `env KEY=VAL …`. Far more invasive than seeding session env once.
