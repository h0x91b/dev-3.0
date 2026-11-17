# Rebuild the env when the app starts inside a dev3 pane

## Context

An agent can start dev3 from inside one of dev3's own panes: the `open` step of a local build install, `dev3 remote` run by hand, or a devScript that boots a dev-channel build. The new process inherits that pane's whole launch env, and the tmux server it starts hands it to every later pane that does not set a key itself.

## Investigation

On macOS, an app started from a task pane and the `dev3` tmux server's global env held about 40 keys from that pane: its project's `CLAUDE_CONFIG_DIR`, Claude Code session keys including `CLAUDE_CODE_MESSAGING_TOKEN`, `ANTHROPIC_*` model pins, project env such as `AWS_PROFILE`, `TMUX`, `TMUX_PANE`, and the task's `DEV3_TASK_*`, `DEV3_PROJECT_*` and `DEV3_PORT*` keys. Stripping a fixed key list missed most of them, and a Repo terminal, which unsets `DEV3_TASK_ID`, went undetected.

## Decision

`src/bun/pane-launch-env.ts` runs first in both entries, before the launch-origin check of `os-launched-app-is-never-a-guest`, skills install and the login-shell import. When `DEV3_TASK_ID` or `DEV3_PROJECT_PATH` is set, or `TMUX` names the `dev3` socket, `resetEnvFromDev3Pane` keeps only a fixed list of OS and desktop-session keys plus every `DEV3_*` and `BUN_*` key, and the login shell then restores the user's own values on that base. `DEV3_*` stays in the app's env because the app reads it (`DEV3_HOME`, a dev build's `DEV3_PORT1`, guest detection), but `withoutLaunchTaskWiring` unsets the launching task's per-task `DEV3_*` keys in the env of every tmux command that can start a server. It sets them to `undefined` rather than deleting them, because `spawn.ts` merges `process.env` under every spawn and `undefined` is what unsets a key there.

## Risks

- Dropped for a pane-launched app: keys set on purpose for that launch (`dev3 dev-server start --env CLAUDE_CONFIG_DIR=...`, a devScript export), and values from `launchctl setenv`, `environment.d` or PAM, which the login shell does not restore. With `importShellEnv` off, dotfile values are not restored either.
- Kept with the pane's value: the base keys, so a project env that sets `PATH`, `TMPDIR` or `LD_LIBRARY_PATH` still reaches the app. The app's own children other than tmux still get `DEV3_TASK_ID` and the other `DEV3_*` keys.
- The base list is fixed; a platform variable the app needs must be added there. A tmux server already running keeps its env until it restarts.

## Alternatives considered

- A fixed list of keys to strip. Rejected: project env is user-defined, so no list can name it.
- Always dropping an inherited `CLAUDE_CONFIG_DIR`. Rejected: a user-wide one is a supported setup (`per-project-claude-config-dir` record).
- Cleaning only the env given to the tmux server. Rejected: the app reads `process.env` itself (skill install, the pinned Claude dir fallback).
