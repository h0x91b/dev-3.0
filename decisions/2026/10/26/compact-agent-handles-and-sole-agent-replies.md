# Compact agent handles, and `--agent` only where it disambiguates

## 1. Context
`agent-addressed-messages-and-replies` made the `--agent` handle the base64url of the whole author binding (pane, conversation id, pane generation, `pid@lstart`): ~140 characters in every `<reply-with>`, even for a task with a single agent, where the task address already reaches the sender.

## 2. Investigation
The handle only has to pick one process the app can still see: a pane id alone survives the agent it named (tmux reuses `%N`, an exited agent leaves a shell), so it needs a generation part, but the full binding can be read back from the pane at send time. Replies are built when the envelope is typed (`deliverToTarget`), which is async, so the agent count can be taken there.

## 3. Decision
- `src/shared/agent-handle.ts`: handle = `<paneId>.<d(paneToken)>.<d(pid@start)>[.<d(sessionId)>]`, each `d` an FNV-1a 32 digest (8 hex), ~30 characters. `resolveAgentHandle` (`src/bun/agent-message-target.ts`) accepts the agent now in that pane when pane, generation and process digests all match, or else applies #2062's relocation rule: exactly one `sessionState` pane whose conversation digest matches, running an agent, in another pane or under a new pane generation. The resulting full author goes on exactly as before (release-time `verify`, stored `ScheduledMessage.author`), so nothing on disk changes.
- Old `a1.` handles fail closed with an error that says to copy the current handle from `dev3 pane list` (repo policy: no compatibility path).
- `isSoleMainAgent`: the reply drops `--agent` only when the sender's task has one live agent (sessionState agents + AI Review panes; shell splits never count), it is the main pane, and `resolveScheduledMessageAuthorPane` still finds the sender there. An uncountable task keeps `--agent`. The spill still measures the longer, `--agent` form.

## 4. Risks
A reply without `--agent` is task-addressed: if the sender's main agent is replaced between delivery and the reply, the reply reaches the new main agent instead of being refused (it is still never typed into a shell: `resolveMainAgentTarget` refuses an exited agent). An agent added after delivery changes nothing, the reply still lands on the main agent. Digests are 32 bits, not proof of identity: a different process in the same pane passes only if both its generation and process digests collide (~2^-32 on one server); relocation picks a wrong agent only if the real conversation is gone from `sessionState` and another recorded pane's conversation digest collides (~k·2^-32 for k recorded panes), and two matches are refused. Unlike #2062, which reads the original pid with `ps`, relocation infers the original agent is gone from its pane no longer matching (or being unreadable, which is also what a tmux restart looks like). Old `a1.` handles in envelopes delivered since #2062 (merged 2026-10-26) stop working after an upgrade: nothing is sent and the agent re-reads `dev3 pane list`.

## 5. Alternatives considered
A bare pane id: cannot tell a replacement from the agent it named. A short id stored in the app: new on-disk state. One combined digest (12-char handle): cannot tell a moved conversation from a replacement, so #2062's relocation would be lost. Counting at send time and storing it on the message: a scheduled message fires hours later, so the count would be older.
