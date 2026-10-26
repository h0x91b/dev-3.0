# Compact agent handles, and `--agent` only where it disambiguates

## 1. Context
`agent-addressed-messages-and-replies` made the `--agent` handle the base64url of the whole author binding (pane, conversation id, pane generation, `pid@lstart`): ~140 characters in every `<reply-with>`, even for a task with a single agent, where the task address already reaches the sender.

## 2. Investigation
The handle only has to pick one process the app can still see: a pane id alone survives the agent it named (tmux reuses `%N`, an exited agent leaves a shell), so it needs a generation part, but the full binding can be read back from the pane at send time. Replies are built when the envelope is typed (`deliverToTarget`), which is async, so the agent count can be taken there.

## 3. Decision
- `src/shared/agent-handle.ts`: handle = `<paneId>.<FNV-1a 32 of paneToken + pid@start>`. `resolveAgentHandle` (`src/bun/agent-message-target.ts`) reads the agent in that pane now and accepts it only when the digest matches; the resulting full author goes on exactly as before (release-time `verify`, stored `ScheduledMessage.author`), so nothing on disk changes.
- `isSoleMainAgent`: the reply drops `--agent` only when the sender's task has one live agent (sessionState agents + AI Review panes; shell splits never count), it is the main pane, and `resolveScheduledMessageAuthorPane` still finds the sender there. An uncountable task keeps `--agent`. The spill still measures the longer, `--agent` form.

## 4. Risks
A reply without `--agent` is task-addressed: if the sender's main agent is replaced between delivery and the reply, the reply reaches the new main agent instead of being refused (it is still never typed into a shell: `resolveMainAgentTarget` refuses an exited agent). An agent added after delivery changes nothing, the reply still lands on the main agent. A handle no longer follows a conversation resumed in another pane (the old `sessionId` fallback): that send is refused, with the live agents listed. Old `a1.` handles in already-delivered envelopes are rejected as malformed. Generation digests are 32 bits: they separate generations, they are not a secret.

## 5. Alternatives considered
A bare pane id: cannot tell a replacement from the agent it named. A short id stored in the app: new on-disk state. Counting at send time and storing it on the message: a scheduled message fires hours later, so the count would be older. Keeping the conversation-id fallback with a second digest: longer handle for a rare post-restart case.
