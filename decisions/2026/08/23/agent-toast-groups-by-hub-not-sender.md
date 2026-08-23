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
hub in either direction. One message renders as two clickable squares; two or
more render as a graph — hub on one side (or in the middle for mixed traffic),
counterparts on the other, one wire each with a slow travelling dot.

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

## Alternatives considered

- **Group by sender.** Half the cases; the inbound pile survives.
- **A counter badge on one card** ("+4 more messages"). Cheap, but it throws away
  exactly the topology the user asked to see.
- **Never group, shorten the toast.** Does not fix volume; the cap still evicts.
