# Drop the pane env an app inherits when it starts inside a dev3 pane

## Context

An agent can start dev3 from inside one of dev3's own panes: the install step of a local build (`open` on the new app), a `dev3 remote` started by hand, or a devScript that boots a dev-channel build. The new process then carries the env that pane's launch wrote: `CLAUDE_CONFIG_DIR` from a project pin or an account, the `ANTHROPIC_*` model and API keys, and the pane's `TMUX` and `TMUX_PANE`. `TmuxClient.startServerIfMissing` starts a tmux server with the whole `process.env`, so every later pane that does not set a key itself inherits that one task's values. A project with no Claude folder of its own then ran `claude` on the other project's folder, and the app's own reads of `process.env.CLAUDE_CONFIG_DIR` (skill install, the pinned-dir fallback) pointed at it too. Measured on macOS: the installed app and the `dev3` tmux server's global env held another task's `CLAUDE_CONFIG_DIR`, `ANTHROPIC_MODEL`, `TMUX` and `TMUX_PANE`.

## Decision

`stripPaneLaunchEnv` (`src/bun/shell-env.ts`) runs first in both entries (`index.ts`, `headless-entry.ts`). When `process.env.DEV3_TASK_ID` is set, it deletes every key in `claudeApiProfileEnvKeys()` plus `TMUX` and `TMUX_PANE`. It runs before skills install and before `resolveShellEnv`, so the login shell that the env dump spawns no longer inherits them, and a value the user exports in their dotfiles comes back through the normal shell import. `DEV3_TASK_ID` itself stays: guest detection (`hostTaskId` in the socket sidecar) reads it.

## Risks

- A value that reached the app only through the launching pane, and not through the user's dotfiles, is gone for that run. With `importShellEnv` off, a dotfile value is not restored either. Starting the app outside a pane keeps today's behaviour.
- The key list is the API-profile set. A new agent key dev3 starts writing into panes needs adding there, or it leaks the same way.
- A tmux server that is already running keeps the global env it started with; this change only affects servers the app starts.

## Alternatives considered

- Always dropping an inherited `CLAUDE_CONFIG_DIR`. Rejected: a `CLAUDE_CONFIG_DIR` set for the whole user is a supported setup (`per-project-claude-config-dir` record), and the account code already avoids touching the ambient env of users who do not use accounts.
- Stripping only the env handed to the tmux server. Rejected: app-side reads of `process.env` would still see the other task's folder.
- Spawning the tmux server with a curated env. Rejected: the server env is what gives every pane the user's PATH and credentials; a curated list would break that for all users to fix a launch-from-pane case.
