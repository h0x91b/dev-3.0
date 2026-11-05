> Superseded on 2026-10-26 in part by `decisions/2026/10/26/compact-agent-handles-and-sole-agent-replies.md`: the handle is now `<pane>.<generation digest>`, resolved by the app, and a reply drops `--agent` when the sender is its task's only agent.

# Address messages to one agent process, and route replies back to it

## 1. Context
A task can run several agents: the main one, `+ Agent` extras and the AI Review agent. `dev3 message` addressed only the task, and delivery picked the last-focused agent pane (`resolveAgentPromptTargetPane`, `decisions/2026/07/22/agent-prompt-last-focused-pane.md`), so a coordinator's follow-up moved with the user's focus and a reviewer could not be reached at all: AI Review panes never enter `sessionState` (#1809).

## 2. Investigation
`decisions/2026/10/06/scheduled-self-reminder-author-binding.md` already binds a self-reminder to an agent PROCESS (pane, pane generation, `pid@lstart`) and refuses rather than redirects. That identity works for any agent, registered or not, and survives what a pane id does not: tmux reusing ids, and an agent exiting while its pane lives on as a shell. The hold (`agent-message-hold.ts`) typed a message seconds after it was resolved, checking only that the pane still existed.

## 3. Decision
- Task-addressed held messages go to the MAIN agent (`sessionState.panes[0]`, `pane-1` on native) through `resolveMainAgentTarget` (`src/bun/agent-message-target.ts`), bound to the process running there. An exited main agent means not delivered, never a sibling. Button hand-offs keep the focus rule.
- `dev3 pane list` adds each agent pane's role and an opaque handle (`src/shared/agent-handle.ts`, base64url of the author binding); `dev3 message --agent <handle>` stores it as `ScheduledMessage.author`.
- Every bound message is checked again at release (`HeldAgentMessage.verify`, `addressedAgentRefusal`); a refused one is dropped and reported on the task.
- The sender is captured on every agent-sent message (`withSenderAgent`, including the launch hand-off), and `<reply-with>` carries `--agent <sender handle>`. With no proven sender the envelope has `<reply-unavailable>` and no reply command, and the CLI tells the sender.

## 4. Risks
Windows has no `pid@start` reader, so there `--agent` is refused and replies are unavailable (follow-up issue). A native delivery forwarded to another app process is checked right before the hand-over, not again at release. Native `+ Agent` panes are not recorded in `sessionState` (updated 2026-10-28: they and bug hunters are labeled from a launch-script sidecar, see `native-agent-attribution.ts`). A message the user's own shell sends from a worktree no longer gets a task-level reply command.

## 5. Alternatives considered
Raw pane ids as addresses: reused across tmux servers and blind to a replaced agent. Registering AI Review in `sessionState`: rejected in the author-binding record for its recovery blast radius. A short id stored in the app: new on-disk state for something the handle carries itself. A task-level reply when the sender is unknown: may reach a sibling of the asker, which is the defect.
