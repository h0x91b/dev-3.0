# Extra agent exit runs after the turn ends

## Context
Extra "+ Agent" panes had no way to end their own session; the user closed each pane by hand. `dev3 agent exit` runs inside the agent's turn, so the pane cannot be killed at once (that cuts the CLI call) and `/exit` cannot be typed at once (a busy agent loses it).

## Decision
`dev3 agent exit` only schedules the exit (`src/bun/cli-agent-exit.ts`, `src/bun/extra-agent-exit.ts`, state in `extra-agent-exit-state.ts`); the pane's next Stop from its own interactive agent (matching recorded session, else interactive Codex or a non-Codex harness) arms a 1 s settle that any `UserPromptSubmit` cancels, and a 5-minute deadline closes the pane without typing. Then the pane is pinned, the turn and a per-exit cancellation token are re-checked with nothing awaited before the keystrokes, the adapter's `exitProgram()` is typed, the subtree is awaited and the pane closed; a task note records the conversation id and resume command. The exit is bound to the agent it was asked for (process identity, else session id and root pid) and re-checked after approval, before typing and before the kill; only a different live agent drops it, and every pane or task teardown path cancels it, a close in flight included. Extra agents are written with `main: false`; `mainPaneEntry` takes `main === true`, else index 0 only when that entry has no `main` key, so a dead main never promotes an extra and a pre-flag main keeps its role.

## Risks
The schedule lives in memory: a restart forgets it and the agent keeps running. The hard close can cut a long tool call of an agent that never reported a turn end. A native "+ Agent" pane has no recorded conversation id, so its note says "id unknown". A prompt that lands after the keystrokes were written cannot be caught. On Windows the quit command cannot be typed (no pane pin), so the pane closes right after the Stop.

## Alternatives considered
Typing `/exit` right away loses it in a busy agent. Killing the pane from the CLI call cuts the turn that asked. Polling the screen has no harness-neutral signal. Persisting the schedule costs a state file to save one idle agent.
