# Rebuild the env when the app starts inside a dev3 pane

## Context

An agent can start dev3 from inside one of dev3's own panes: the `open` step of a local build install, `dev3 remote` run by hand, or a devScript that boots a dev-channel build. The new process inherits that pane's whole launch env, and the tmux server it starts hands it to every later pane that does not set a key itself.

## Investigation

On macOS, an app started from a task pane and the `dev3` tmux server's global env held about 40 keys from that pane: its project's `CLAUDE_CONFIG_DIR`, Claude Code session keys including `CLAUDE_CODE_MESSAGING_TOKEN`, `ANTHROPIC_*` model pins, project env such as `AWS_PROFILE`, `TMUX`, `TMUX_PANE`, and the task's `DEV3_TASK_*`, `DEV3_PROJECT_*` and `DEV3_PORT*` keys. Stripping a fixed key list missed most of them, and a Repo terminal, which unsets `DEV3_TASK_ID`, went undetected.

## Decision

`src/bun/pane-launch-env.ts` runs first in both entries, before any other env read, skills install and the login-shell import. When `DEV3_TASK_ID` or `DEV3_PROJECT_PATH` is set, or `TMUX` names the `dev3` socket, `resetEnvFromDev3Pane` keeps only a fixed list of OS and desktop-session keys plus every `DEV3_*` and `BUN_*` key, and the login shell then restores the user's own values on that base. `DEV3_*` stays in the app's env because the app reads it (`DEV3_HOME`, a dev build's `DEV3_PORT1`, guest detection), but `withoutLaunchTaskWiring` unsets the launching task's wiring in the env of every tmux command that can start a server and of every native terminal host spawn (`registry.ts`, `native-host-runtime.ts`). Wiring is every `DEV3_*` key outside a short allowlist of app-wide keys (`DEV3_HOME`, `DEV3_LOG_DIR`, `DEV3_QA_SCOPE`, `DEV3_FRESH_START`, `DEV3_REMOTE_*`, ...). An allowlist, because the per-task keys have no common prefix and new ones keep appearing (`DEV3_ARTIFACT_TEMPLATE`, `DEV3_LEAN_PROTOCOL`, `DEV3_PANE_ID`): a new pane key is dropped without a change here, and a test runs the pane env builders and asserts each `DEV3_*` key they write counts as wiring. A key is unset only when it is absent or still has its launch value, so a caller that sets a new task's id or port keeps it. Unset means `undefined`, not deleted, because `spawn.ts` merges `process.env` under every spawn and `undefined` is what unsets a key there.

## Risks

- Dropped for a pane-launched app: keys set on purpose for that launch (`dev3 dev-server start --env CLAUDE_CONFIG_DIR=...`, a devScript export), and values from `launchctl setenv`, `environment.d` or PAM, which the login shell does not restore. With `importShellEnv` off, dotfile values are not restored either.
- Kept with the pane's value: the base keys, so a project env that sets `PATH`, `TMPDIR` or `LD_LIBRARY_PATH` still reaches the app. The app's own children other than tmux and native hosts (hooks, git, agent CLIs) still get `DEV3_TASK_ID` and the other `DEV3_*` keys.
- The reset changes Bun's `process.env`, not the native environ: native code (GTK, WebKit) and the processes it starts still see the full launch env. Only children dev3 spawns get the rebuilt env.
- An app-wide `DEV3_*` key missing from the allowlist does not reach panes of a pane-launched app, which then fall back to the default. The base list is fixed, so a platform variable the app needs, or a proxy or CA variable set only through PAM or `/etc/environment`, must be added there. A tmux server already running keeps its env until it restarts.

## Alternatives considered

- A fixed list of keys to strip. Rejected: project env is user-defined, so no list can name it.
- Always dropping an inherited `CLAUDE_CONFIG_DIR`. Rejected: a user-wide one is a supported setup (`per-project-claude-config-dir` record).
- Cleaning only the env given to the tmux server. Rejected: the app reads `process.env` itself (skill install, the pinned Claude dir fallback).
