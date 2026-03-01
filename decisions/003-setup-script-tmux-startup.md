# 003 — Setup script via /tmp files (no env vars)

## Context

Need to show the setup script in a separate tmux pane (pane 0) while the agent runs in the bottom pane (pane 1). Two modes: foreground (agent waits for setup) and background (both run in parallel).

## Investigation

**Attempt 1: env vars.** Pass setup script and claude command via `DEV3_SETUP_SCRIPT` / `DEV3_CLAUDE_CMD` env vars set in `Bun.spawn`. Failed because tmux server does NOT inherit env vars from the client process — only `DISPLAY`, `SSH_*`, etc. are propagated by default. Custom `DEV3_*` vars never reach panes → startup script sees empty strings → `[dead]` pane.

Confirmed: `tmux show-environment -t dev3-xxx` does not contain `DEV3_*`.

**Attempt 2: temp files.** Write content directly to files instead of env vars. Works reliably.

## Decision

Three files in `/tmp/`:
- `dev3-{taskId}-setup.sh` — raw setup script content
- `dev3-{taskId}-cmd.sh` — `exec {tmuxCmd}` (the agent command)
- `dev3-{taskId}-startup.sh` — orchestration (calls setup + split-window + cmd)

Referenced by absolute path — no env vars, no escaping. Logic in `src/bun/rpc-handlers.ts` → `launchTaskPty`. On reconnect (`getPtyUrl`) `runSetup = false` so setup doesn't re-run.

## Risks

- If `/tmp` is not writable the task won't start. Practically impossible on macOS/Linux.
- `DEV3_TASK_TITLE` and other `extraEnv` vars are also unavailable in panes — pre-existing issue. Use tmux `-e` flag for critical data.

## Alternatives considered

- **Env vars via `Bun.spawn`** — broken by tmux server/client architecture.
- **Inline escaping in tmuxCmd** — too fragile for arbitrary user input.
- **tmux `-e` flag** — works in tmux 3.2+ but still requires escaping.
- **Named pipe for sync** — overkill.
