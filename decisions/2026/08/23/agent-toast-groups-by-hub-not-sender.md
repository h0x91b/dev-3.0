# Agent-traffic toasts group by hub, not by sender

## Context

A coordinator driving several tasks produced one violet toast per `dev3 message`.
Five stacked cards said the same thing five times, hit the visible-toast cap, and
still did not answer the question the user actually had: who is talking to whom.
The obvious fix — fold consecutive messages from the same sender — only covers
fan-out. The reverse case (three workers all reporting back to the coordinator)
is at least as common and would have stayed a pile.

## Decision

An agent toast carries an `AgentToastLink` with BOTH task ids, and `ToastHost`
folds a new message into a live card when they share a participant
(`sharedParticipant` in `src/mainview/components/AgentMessageToast.tsx`). That
shared task becomes the card's `hubTaskId`; later messages join if they touch the
hub in either direction.

The card is a composition of boxes, not one notification: the hub is a box on the
left, its counterparts are boxes on the right under a `received` / `sent` label,
and the message text lives in the channel between them, on an orthogonal bracket
with a slow travelling dot. A lone message uses the same shape with the RECEIVER
as the hub — that is where the text landed, and it keeps the card from turning
itself inside out when a second message arrives (`sharedParticipant` prefers the
receiver when both ends match).

Legs collapse by COUNTERPART, never by message: five messages from one task are
one box carrying `×5` and the newest text. An earlier form drew a node per
message and produced five identical `#1141` nodes with neither a name nor any
text — the exact pile this was meant to replace.

Selection is by toast variant, not by adjacency: an error or success toast
landing between two messages is skipped, never folded in and never treated as
the end of a burst.

## Risks

- A task that legitimately talks to two unrelated groups at once puts all of it
  on one card, because both bursts share it. Acceptable: that task IS the hub.
- The graph measures its wires from the laid-out DOM (`getBoundingClientRect` +
  `ResizeObserver`). In an environment with no layout (happy-dom) it renders the
  nodes and simply draws no wires, which is why the tests assert on nodes and
  counts rather than on path geometry.
- Absorbing resets the card's dwell timer, so a chatty hub can keep one card on
  screen. That is the intent — it is one live conversation, not five events.
- Height is this form's price: four legs measure ~314px, which is why
  `MAX_AGENT_LEGS` is 2 per direction and the rest become a `+N` line. The card
  is also wider than an ordinary toast (32rem vs 26rem) — it holds two columns of
  boxes plus the channel between them.

## Alternatives considered

- **Group by sender.** Half the cases; the inbound pile survives.
- **A counter badge on one card** ("+4 more messages"). Cheap, but it throws away
  exactly the topology the user asked to see.
- **Never group, shorten the toast.** Does not fix volume; the cap still evicts.
- **One card with a node graph** (shipped first, rejected on sight). Compact, but
  a node had room for a number and nothing else: no task name, no message text.
- **Five other compositions** — a pair, a thread, a scatter, a stack of pairs, a
  deck — were mocked and measured against this one; the fan won because it is the
  only shape that keeps every counterpart's name AND its text on screen at once.

## Note

A status dot per box was in the mock and is NOT implemented: the push event
carries no task status, and the sending task can live in another project, so
resolving it in the renderer would be wrong as often as right.
