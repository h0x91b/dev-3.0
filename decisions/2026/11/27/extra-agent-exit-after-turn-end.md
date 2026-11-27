# Extra agent exit runs after the turn ends

## Context
Extra "+ Agent" panes had no way to end their own session; the user closed each pane by hand. `dev3 agent exit` runs inside the agent's turn, so the pane cannot be killed at once (that cuts the CLI call) and `/exit` cannot be typed at once (a busy agent loses it).

## Decision
The command only schedules the exit (`src/bun/cli-agent-exit.ts` → `scheduleExtraAgentExit` in `src/bun/extra-agent-exit.ts`). The pane's turn-end hook is the trigger and the proof that a prompt is there to type into; per-pane state lives in `src/bun/extra-agent-exit-state.ts`. A Stop arms a 1 s settle timer, a `UserPromptSubmit` cancels it, and the 5-minute deadline closes the pane without typing. Then the adapter's `exitProgram()` is typed, `waitForPanesToEmpty` waits for the subtree, and the backend-neutral `close` pane action removes the pane; a task note records the conversation id and the resume command.

A prompt always counts for its pane, because it can only postpone the exit. A Stop counts when the pane's recorded session matches; with no recorded session (native panes) only an interactive Codex conversation or a non-Codex harness counts, so a nested `codex exec` never ends the wait. The busy check is the last step before typing and before the close, after every awaited preflight.

The exit is bound to the agent it was asked for (`readPaneAgentIdentity`, else the entry's session id and root pid), checked after approval, before typing and before closing. Only a different live agent or conversation drops the exit; an agent that already left is what the exit wants, so its pane is still closed. Each exit carries a cancellation token: a pane exit (before the quit command went out), a task teardown, a native pane close or a native pane-set stop (`handlePaneExited`, `destroySession`, `destroySessionAwaited`, `destroyNativeTaskSession`, `tearDownTaskTerminal`, `closeNativeTaskPane`, `stopNativeTaskPanes`) cancels it, and a run in flight stops at its next check.

Every later agent entry (`spawnAgentInTask`, bug hunters) is written with `main: false`, and `mainPaneEntry` (`src/shared/main-pane-entry.ts`) treats index 0 as the main only for legacy data with no `main` key. So when the main pane dies while extras live, `agentPaneRoles` and `mainAgentPaneId` do not promote an extra.

## Risks
The schedule lives in memory: a restart forgets it and the agent keeps running. The hard close can cut a long tool call of an agent that never reported a turn end. A native "+ Agent" pane has no recorded conversation id, so its note says "id unknown".

## Alternatives considered
Typing `/exit` right away loses it in a busy agent. Killing the pane from the CLI call cuts the turn that asked. Polling the screen has no harness-neutral signal. Persisting the schedule costs a state file to save one idle agent.
