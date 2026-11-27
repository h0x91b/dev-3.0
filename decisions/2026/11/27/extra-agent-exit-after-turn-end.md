# Extra agent exit runs after the turn ends

## Context
Review agents (extra "+ Agent" panes) had no way to end their own session; the user closed each pane by hand. `dev3 agent exit` is called from inside the agent's turn, so the pane cannot be killed at once (that cuts the CLI call and the turn) and `/exit` cannot be typed at once (a busy agent queues or loses it).

## Decision
The command only schedules the exit (`src/bun/cli-agent-exit.ts` → `scheduleExtraAgentExit` in `src/bun/extra-agent-exit.ts`) and returns. The pane's own turn-end hook is both the trigger and the proof that a prompt is there to type into: Claude's `Stop` (`task.claudeTurnEnded`) and the status-hook `Stop` of the other harnesses (`task.agentHook`) feed a per-pane "last report" map. A report counts only when its session id matches the pane's recorded conversation. A Stop arms a 1 s settle timer; a `UserPromptSubmit` before it fires cancels it, and the exit waits for the next Stop under the original 5-minute deadline. Then the adapter's `exitProgram()` is typed, the pane subtree is awaited with the shared `waitForPanesToEmpty`, and the pane is closed through the backend-neutral `close` pane action, so `agent resume` does not bring it back. A task note records the conversation id and the harness resume command, captured before the pane entry leaves the task; a failed close leaves a note too. A caller that is idle already (another agent, last report `Stop`) is closed at once, and a self exit approved after its own turn ended starts at once.

The exit is bound to the agent instance it was asked for: the process identity (`readPaneAgentIdentity`) is captured before the dialog opens, rechecked after approval, before typing and before closing; the pane entry's session id and root pid are the fallback where identity cannot be proven. A mismatch drops the exit with a task note. The in-memory state is cleared when its pane exits (`handlePaneExited`) and when the task's terminal is torn down (`destroySession`).

A harness that sends no turn-end hook (Cursor, Gemini, OpenCode today) or a pane that never reports one gets the 5-minute deadline: the pane is closed hard without typing anything. A harness with no quit command is closed hard right after its Stop. On Windows `sendPaneInput` cannot pin a native pane, so no quit command is ever typed there: the pane is closed right after the Stop. The confirmation reuses the launch-approval dialog (`close-agent` session action) and is switched off by `confirmExtraAgentClose` (Settings → Tasks & Board).

## Risks
The schedule lives in memory: a restart forgets it and the agent keeps running. The 5-minute hard close can cut a long tool call of an agent that never reported a turn end. A native "+ Agent" pane has no recorded conversation id, so its note says "id unknown".

## Alternatives considered
Typing `/exit` right away: lost in a busy agent. Killing the pane from the CLI call: cuts the turn that asked. Polling the screen for a prompt: no harness-neutral signal, and the Stop hook already exists. Persisting the schedule: the cost of a forgotten exit is one idle agent, not worth a new state file.
