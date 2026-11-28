# Cursor status hooks in the user-level hooks file

## Context

Cursor Agent tasks had no status hooks, only usage accounting, so the board moved only when the model remembered `dev3 task move`. After the user replied in Has Questions the card stayed there while the agent worked (h0x91b/dev-3.0#2446).

## Investigation

Cursor documents `beforeSubmitPrompt`, `preToolUse`, `postToolUse` and `stop` (https://cursor.com/docs/hooks); `stop` carries `status` (completed, aborted, error). The installed CLI's hook runner (cursor-agent 2026.02.27) runs every command through its bash executor with `{...process.env, ...}` plus `CURSOR_PROJECT_DIR`, feeds the payload on stdin, and runs user hooks from `~/.cursor`. An empty answer only logs a failure, `continue: false` alone blocks a prompt, and an invalid `preToolUse` answer is treated as a denial. A live run was not possible: the CLI on the dev machine is signed out.

## Decision

`writeCursorHooks` (`src/bun/cursor-hooks.ts`) merges `beforeSubmitPrompt`, `postToolUse` and `stop` entries into `~/.cursor/hooks.json` next to the usage hooks, replacing only dev3's own entries. Each command checks `DEV3_TASK_ID` and the dev3 executable in the shell and otherwise prints `{}`. `dev3 hook cursor <event>` (`src/cli/commands/cursor-hook.ts`) maps them through `cursorStatusEvent` to the shared `task.agentHook` events, sends an errored `stop` to the stop-failure path, reports an aborted `stop` (Esc) as `Interrupt`, and always prints `{}`. `preToolUse` is not used. Cursor keeps the manual protocol and parks its card itself at turn end, often followed by `dev3 attention` or `dev3 overview set`; `task.agentHook` therefore holds a `cursor` card in Has Questions through PostToolUse and Stop until the next UserPromptSubmit (`SELF_PARKING_HARNESSES` in `src/shared/agent-hooks.ts`).

## Risks

The `DEV3_TASK_ID` inheritance was read from the bundle, not observed live; if a future Cursor stopped passing the environment, the hooks would go silent (never block). An agent that parks itself mid-turn and keeps working stays in Has Questions until the turn's next prompt. The guard is per task, not per agent: a `cursor-agent` run by hand in another pane of the task, or a Cursor IDE launched from a dev3 pane, also drives the card (as with Copilot). After a downgrade the older CLI has no `hook cursor` subcommand, so each event spawns a failing, non-blocking process until `dev3 install-hooks --remove-cursor`.

## Alternatives considered

A project `.cursor/hooks.json` in the worktree runs from the worktree, but writes into the user's repository and collides with a tracked file. Hooking `preToolUse` would make a broken dev3 able to block every tool. Switching Cursor to the native-hooks protocol body would let PostToolUse and Stop fight the agent's semantic Has Questions move; the manual body plus hooks as a safety net avoids that.
