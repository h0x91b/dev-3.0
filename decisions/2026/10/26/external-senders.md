# External senders: an outside agent messages a task and reads its replies

## Context

An agent outside dev3 (an OpenClaw gateway, Claude Desktop, a script) could already reach a task with `dev3 message --task`, but its text read as the user's, the task could not answer it, and the send result was a bare exit 0 that hid held vs delivered (issue #2066, PR 1 of 2).

## Investigation

The CLI socket answers one request batch per connection and the client gives up at 30 s, so a reply channel has to be a long-poll, not a stream. `~/.dev3.0` is shared by every installed instance, so a reply may be appended by one instance while the sender waits on another. `ScheduledMessage.source` (an `AgentMessageSource`) is persisted in `tasks.json`, so a new member there would be read by older versions.

## Decision

- Every immediate send gets `crypto.randomUUID()` as its id (`sendMessageImmediately`), logged as `messageId` and printed by `dev3 message --json`. A transport lost after sending exits 11 (`{"status":"unconfirmed"}`); a connect that never happened keeps the app-not-running exit 2 (`{"status":"not-delivered"}`), because the socket client already folds ECONNREFUSED/ENOENT into that one verdict.
- Senders live in `~/.dev3.0/external-senders.json`, hand-edited and only read (`src/bun/external-senders.ts`). `--as-sender` is refused inside a task and with `--in/--at`, so it is never persisted on a queued message. Log rows say `origin: "external-sender"` + `fromSender`; `AgentMessageSource` is unchanged. The envelope is `<dev3-ai-message>` with `<from-sender>`, `<message-id>` and a `--to-sender` reply command.
- Replies go to `~/.dev3.0/external-senders/<slug>/YYYY-MM-DD.jsonl` (`src/bun/external-sender-inbox.ts`): append-only `item`/`ack`/`pruned` rows, 0600, one write per row under 8 KB, larger bodies in `bodies/<id>.md`. The file is the source of truth; waits poll it every second plus `fs.watch`, and acks are folded from it on every read. Cap 500 unacked; 30-day prune writes a `pruned` row first, deletes that day's spilled bodies whether acked or not, and `sender.wait` reports the notice once (`pruned: [{day, unacked}]`). Rows never go into a day-file older than the newest one, so an append racing midnight cannot land behind a cursor. The slug maps `:` to `__`; ids may not contain `__`, `_:` or `:_`, so the mapping stays one-to-one.
- `sender.wait` parks at most 25 s and returns early when the client's connection closes (an abort signal threaded through `cli-listener.ts`). One reader lease per sender, held only by a wait with a `clientId`, kept for 10 s after its last wait; a second client exits 40 unless a person passes `--take-over`.
- Routing next to `agent-addressed-messages-and-replies`: a sender's message is task-addressed, so it goes to the task's main agent. `--as-sender` with `--agent <handle>` is refused (exit 3, and by `message.sendAsSender`): agent handles name agents inside dev3, and narrower is easier to widen later. A sender message carries no `AgentMessageSource`, so its envelope never gets the per-agent `dev3 message --task … --agent …` reply. `--to-sender` is its only reply, and it never appears on task-to-task traffic.
- A start (`task move --as-sender`) or resume (`agent resume --as-sender`) goes through the existing launch dialog and its auto-approve setting, which names the sender (`AgentLaunchRequest.requesterSender`).
- Every sender request travels on its own method name (`message.sendAsSender`, `task.moveAsSender`, `agent.resumeAsSender`, `sender.*`; `withSenderVariant` in `cli-socket/shared.ts`). An older app answers "Unknown method" instead of ignoring `asSender`, which would type the text as the user and start a task without the dialog; the plain methods refuse `asSender`. `dev3 message --json` prints one verdict on every exit, discovery-stage exit 2 included.

## Risks

Threat model: the identity is self-asserted on a socket only the same user can reach, so it is attribution, not authentication. Inbound is no worse than today, where outside text already reads as the user. Outbound is the real exposure: any local task can `--to-sender` any registered sender, so a sender must treat every inbox item as untrusted data. The lease is in memory per instance, so two instances could each grant one; the cap is soft across instances for the same reason. Two instances that both scan before either prunes can still write two `pruned` rows for one day — a harmless duplicate notice, accepted.

Two gaps closed on 2026-10-27, in the shared code so every caller gets them. Sender text was pasted raw between `<message>` tags, so relayed third-party text could close the envelope and forge a `<from-task>` block; `wrapExternalSenderMessage` now escapes the `<` of `</message>`, `</dev3-ai-message>` and `<dev3-ai-message`. And `task.moveAsSender` on an already running task fell through to a plain move that could start a `review-by-*` column agent with no dialog; now a same-status move is a no-op and any other move, custom columns included, is refused.

## Alternatives considered

Webhook push to the sender: agent sandboxes block curl to localhost, and it needs an inbound port. Reusing `notifications.json`: that file is user-configured egress with its own semantics, not a per-sender queue. A new `AgentMessageSource` member: it is persisted in `tasks.json`, and the two previous releases would read a shape they do not know.
