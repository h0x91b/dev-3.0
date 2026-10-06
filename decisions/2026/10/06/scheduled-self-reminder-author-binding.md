# Bind a scheduled self-reminder to the agent process that queued it

## 1. Context
`dev3 message --in/--at` stored every queued message as `{ kind: "agent" }`, and the fire resolved that by focus (`resolveAgentPromptTargetPane`: last-focused agent pane first; native always `pane-1`). In a task with two agents, agent A's wake-up reached agent B (seq 2091). Cross-task addressing (#1809) is out of scope.

## 2. Investigation
No registry knows every agent: AI Review panes (`launchColumnAgent`) and native extra agents never enter `sessionState.panes`. Pane ids are reused across tmux servers. And an agent that exits does not close its pane: `buildCmdScript` `exec`s a shell into the same root pid, so "pane alive" and `pane_pid` both survive the agent. A live pane reads `launch script (pane root) → agent → tool shell → dev3`; a human's shell split reads `shell (pane root) → dev3`.

## 3. Decision
The author is the agent PROCESS. The CLI sends its pane (`$TMUX_PANE` / `$DEV3_PANE_ID`) and pid; for a self-message only, `captureScheduledMessageAuthor` (`src/bun/scheduled-message-author.ts`) walks a fresh `ps` snapshot to the direct child of the pane root, requires it to be a non-shell with a shell between it and the CLI (an agent's tool call), and stores `{ paneId, sessionId, paneToken, agentProcess: pid@lstart }`. At fire, `resolveScheduledMessageAuthorPane` delivers to the recorded pane while that exact process lives on the same pane generation; otherwise only to the same conversation (`sessionId`) resumed in a NEW pane or server that runs a non-shell child. Anything else → `not-delivered` via the existing drop path (toast + attention, body kept in the message log). Never a sibling or a shell. The start time is read with its own `ps -p PID -o lstart=` rather than the native registry's helper, so the module stays outside the registry's sanctioned-caller boundary (`native-terminal-registry/__tests__/isolation.test.ts`).

## 4. Risks
Older app versions ignore `author` and fire by focus — today's behaviour. No author is captured on Windows (no `ps`), when the receiving instance does not hold the native pane set, for agents launched through a shell wrapper (the direct child is a shell), or for a human in a shell split — those keep task-level routing. A program that runs `dev3` through a shell while living directly under the pane root (e.g. `vim :!dev3`) would be treated as an agent. A resumed conversation is trusted via `sessionState` plus "has a non-shell child".

## 5. Alternatives considered
Registering AI Review and native agents in `sessionState`: wider blast radius (recovery reconciles that list) and still blind to agent exit. Matching agent args like `--session-id`: Claude-only. Holding an unresolvable reminder in the queue: retries every tick and an older version would misfire it anyway. Rerouting every scheduled message to its sender: breaks task addressing for cross-task traffic.
