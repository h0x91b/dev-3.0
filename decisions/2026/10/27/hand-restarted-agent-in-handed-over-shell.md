# A hand-restarted agent in the handed-over shell is the agent

## 1. Context
`readPaneAgentIdentity`, `liveAgentPaneIds` and `taskMainAgentLiveness` (`src/bun/scheduled-message-author.ts`) read a pane whose root process is a bare shell as "agent exited": the launch script `exec`s that shell only after its agent ends. A user who then types `claude` (or `claude --resume <id>`) into that shell has a live agent the checks never see, so `dev3 message` refuses the task, `dev3 pane list` gives no handle, and keep-alive would tear the pane down.

## 2. Investigation
Seen on a live task after a server upgrade to a build with `decisions/2026/10/26/agent-addressed-messages-and-replies.md`. The server restart was not the cause: a dev3-launched agent survives a restart and stays reachable. The failing pane's root was `/usr/bin/zsh` with no argv, and its `claude` child had its own process group and oh-my-zsh in its environment, which only an interactive shell gives.

## 3. Decision
`relaunchedAgentPid` accepts a direct child of the handed-over shell when its executable, or the script a `node`/`bun`/`deno`/`python` runtime runs, has the same basename as the pane's recorded `agentCmd`. All three checks use it. Any other program in that shell, `vim`, `less claude`, a different agent, still means the agent exited.

## 4. Risks
A pane with no `sessionState` entry (the AI Review pane) has no recorded binary, so a hand restart there stays unseen. A user who deliberately runs the same agent binary for an unrelated purpose in that shell now receives the task's messages. Its `sessionId` is the recorded one until the agent's prompt hook reports a new conversation.

## 5. Alternatives considered
Any non-shell child of the handed-over shell: types messages into `vim` or a dev server, which the 2026-10-26 record exists to prevent. Matching the conversation id on the command line: a bare `claude` followed by `/resume` carries none.
