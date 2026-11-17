# Rebuild the env when the app starts inside a dev3 pane

## Context

An agent can start dev3 from inside one of dev3's own panes: the `open` step of a local build install, `dev3 remote` run by hand, or a devScript that boots a dev-channel build. The new process inherits that pane's whole launch env, and `TmuxClient.startServerIfMissing` starts a tmux server with it, so every later pane that does not set a key itself gets the launching task's values.

## Investigation

On macOS, an app started from task seq 78 and the `dev3` tmux server's global env held about 30 keys from that pane: its project's `CLAUDE_CONFIG_DIR`, Claude Code session keys (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_TOKEN`), the `ANTHROPIC_*` model pins, project env (`AWS_PROFILE`, `CLAUDE_CODE_USE_BEDROCK`), `TMUX`, `TMUX_PANE`, `ZDOTDIR`, and the task's `DEV3_TASK_*`, `DEV3_PROJECT_*` and `DEV3_PORT*` keys. A first fix that stripped a fixed list (the API-profile keys plus `TMUX`) missed most of them, and a Repo terminal, which unsets `DEV3_TASK_ID`, was not detected at all.

## Decision

`src/bun/pane-launch-env.ts`, called before skills install and the login-shell import in `index.ts` and as soon as logging is up in `headless-entry.ts`:

- `startedInsideDev3Pane`: `DEV3_TASK_ID` or `DEV3_PROJECT_PATH` is set, or `TMUX` names the `dev3` socket. Not on Windows, which has no dev3 tmux panes.
- `resetEnvFromDev3Pane` keeps only what a freshly started app gets from the OS or session manager (a fixed list: `HOME`, `USER`, `PATH`, `TMPDIR`, `SSH_AUTH_SOCK`, `LANG`, `LC_*`, `XDG_*`, launchd's `XPC_*`/`__CF*`, `DO_NOT_TRACK` and a few more), plus every `DEV3_*` and `BUN_*` key. It deletes the rest. The login shell the env dump spawns then runs on that base, so the user's dotfile values come back through the normal shell import, as in a fresh terminal.
- `DEV3_*` stays in the app's own env because the app reads it: `DEV3_HOME`, `DEV3_QA_SCOPE`, a dev build's `DEV3_PORT0`/`DEV3_PORT1`, and `DEV3_TASK_ID` for guest detection (`hostTaskId`).
- The per-task part of it (`DEV3_TASK_*`, `DEV3_WORKTREE_*`, `DEV3_PROJECT_*`, `DEV3_PORT*`, `DEV3_BRANCH_NAME`, `DEV3_DEV_SERVER`, `DEV3_ARTIFACT_TEMPLATE_DIR`, `DEV3_LEAN_PROTOCOL`, `DEV3_PANE_ID`) is remembered at reset and left out of the env `startServerIfMissing` gives a tmux server (`withoutLaunchTaskWiring`).

## Risks

- A key the caller set on purpose for that launch is dropped unless it is a `DEV3_*` key or the login shell sets it: for example `dev3 dev-server start --env CLAUDE_CONFIG_DIR=...`, or a variable a devScript exports before `bun run dev`.
- With `importShellEnv` off, dotfile values are not restored; the app runs on the OS base plus the resolved `PATH` and `LANG`.
- The OS base list is fixed. A platform variable the app needs and the login shell does not export must be added there.
- A tmux server that is already running keeps the global env it started with; only servers started after this change are clean.
- Detection by `TMUX` assumes dev3's socket keeps the name `dev3` (`DEFAULT_TMUX_SOCKET`).

## Alternatives considered

- Stripping a fixed list of keys (the first version of this change). Rejected: it missed most leaked keys, and project env is user-defined, so no fixed list can name it.
- Always dropping an inherited `CLAUDE_CONFIG_DIR`. Rejected: a user-wide `CLAUDE_CONFIG_DIR` is a supported setup (`per-project-claude-config-dir` record).
- Cleaning only the env given to the tmux server. Rejected: the app itself reads `process.env` (skill install, the pinned Claude dir fallback) and passes it to the processes it spawns.
