# No-agent mark and the agent-exit probe

## Context
A task showed "Disconnected" only when the boot probe wrote `runtimeState.runtime = "idle"` (tmux session gone). A task whose terminal was alive but whose agent had exited, leaving a shell, looked healthy and kept its place in Active Tasks.

## Decision
Both cases share one "No agent" mark (`isTaskAgentless` = `isTaskDisconnected` || `isTaskAgentExited`, `src/shared/types/task-type.ts`); visibility is unchanged and both stay behind the existing eye via `isTaskNotRunning`. The new case is a top-level `Task.agentExitedAt`, written by `src/bun/agent-exit-probe.ts` every 60 s from `taskMainAgentLiveness` over one process table per tick. `exited` sets it, `alive` clears it, `unknown` changes nothing, and a task that stops being a candidate (hibernated, left the active columns, runtime idle) loses a stale flag. `resumeTaskSession` and `restartTask` clear it at once. The flag is persisted, not in memory, so the CLI and every window read the same value.

## Risks
Up to 60 s between the agent exiting and the mark, and between a manual relaunch in a shell and the mark going away. A wrong `exited` verdict would hide a working task behind the eye; the probe only marks on positive proof (the pane's launch script replaced by an interactive shell), and Windows or a failed `ps` read as `unknown`.

## Alternatives considered
Storing it in `runtimeState`: the lifecycle executor owns that object and rewrites it wholesale, so a probe write would race it. An in-memory set in the host: invisible to the CLI and lost on restart. Showing the case in the default list or adding a restart button: the owner kept visibility and actions as they were.
