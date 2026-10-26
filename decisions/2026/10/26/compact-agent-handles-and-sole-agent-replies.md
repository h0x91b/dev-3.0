# Compact agent handles, and `--agent` only where it disambiguates

## 1. Context
`agent-addressed-messages-and-replies` made the `--agent` handle the base64url of the author binding as JSON text (pane, conversation id, pane generation, `pid@lstart`): ~162 characters in every `<reply-with>`, even for a task with a single agent, where the task address already reaches the sender.

## 2. Investigation
Two shorter designs were tried and dropped. Digest handles (pane + FNV-1a digests, 12–30 chars) made the app infer from the pane that the original agent was gone, instead of reading its pid with `ps`. Then a live agent whose pane could not be read was relocated to another pane carrying the same conversation, which #2062 refuses (now a test in `scheduled-message-author.test.ts`). A short alias would need a new persisted registry. Most of the old length is textual UUIDs, the `lstart` date and JSON/base64 overhead, all of which encode losslessly.

## 3. Decision
- `src/shared/agent-handle.ts` (version byte 2): `%N`/`pane-N` as varint N, a lowercase UUID as its 16 bytes, `pid@<ps lstart>` as varint pid + varint naive calendar seconds (read and written in UTC, so timezone and DST never enter). Any value that form would not rebuild character for character (other pane ids, non-UUID ids, unnormalized or localized `ps` output) travels as its raw UTF-8 string. Decoding returns the exact `ScheduledMessageAuthor`, and a handle whose re-encoding differs is refused. A real tmux sender is 46 bytes → 62 characters.
- Resolution is #2062's, untouched: `decodeAgentHandle` → `resolveScheduledMessageAuthorPane` / `HeldAgentMessage.verify`. Old `a1.` handles fail closed with an error pointing at `dev3 pane list` (repo policy: no compatibility path).
- `isSoleMainAgent` (`src/bun/agent-message-target.ts`), asked in `deliverToTarget`: the reply drops `--agent` only when the sender's task has one live agent (sessionState agents + AI Review panes; shell splits never count), it is the main pane, and `resolveScheduledMessageAuthorPane` still finds the sender there. An uncountable task keeps `--agent`. The spill still measures the longer, `--agent` form.

## 4. Risks
A reply without `--agent` is task-addressed: if the sender's main agent is replaced between delivery and the reply, the reply reaches the new main agent instead of being refused. It is still never typed into a shell, because `resolveMainAgentTarget` refuses an exited agent. A lone extra or reviewer (main exited) keeps `--agent`, because task traffic goes only to main; changing that routing is an open decision. Old `a1.` handles in envelopes delivered since #2062 (merged 2026-10-26) stop working after an upgrade: nothing is sent, and the agent re-reads `dev3 pane list`.

## 5. Alternatives considered
A bare pane id: cannot tell a replacement from the agent it named. Digest handles: probabilistic, and they lose #2062's liveness check (see Investigation). A short alias stored in the app: new on-disk state that older versions cannot resolve. Counting agents at send time and storing it on the message: a scheduled message fires hours later, so the count would be older.
