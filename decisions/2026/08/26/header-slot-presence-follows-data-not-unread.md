# A conditional header slot is gated on data, never on having been read

## Context

The agent-traffic pill shipped with its header slot "earned" by unread traffic: it appeared
when a message landed since the user's last look and retired the moment they looked
(`decisions/2026/08/25/agent-traffic-readout-and-log.md`, bible §5.9). The intent was to keep
the header lean — no permanent number nobody acts on.

## Investigation

Living with it broke it. The pill's trigger opens on hover intent (`useHeaderFlyout`, `bar`
variant), and opening is what calls `markTrafficSeen()`. So the sequence the user actually
performs — move the cursor onto the pill to click it — sets `unread` to `0`, which removed the
pill under the pointer. `|| open` kept the panel alive during that hover, so the disappearance
landed the instant the panel closed: the control vanished as a *reward* for having looked at it,
and a second look required going through the kebab. Arseny's verdict on seeing it run: "это не
удобно, пусть будет там всегда пока есть что показывать".

## Decision

Presence follows the data, the badge follows the unread count, and the two are never the same
condition. `AgentTrafficIndicator` now hides the `bar` variant only when there are no pairs at
all (or on a narrow viewport): `if (variant === "bar" && (isNarrow || pairs.length === 0)) return
null;`. The unread badge is unchanged — it still clears when the panel opens, and a project whose
agents never messaged each other still gets no pill. The `|| open` clause is gone, because
opening no longer mutates the condition that keeps the control rendered.

Manifest: bible §5.9 and the yaml `agent_traffic_readout` spec now state the rule as
presence-vs-badge, and the two header complexity-budget rows call the slot conditional rather
than unread-earned.

## Risks

A project with a month of retained traffic and nothing new keeps a badge-less glyph in its header
forever — the "permanent control nobody acts on" cost the first rule was avoiding. Accepted: it
is one 18 px glyph, it is genuinely a live entry point for that project, and it disappears for
projects that never use `dev3 message`.

## Alternatives considered

- **Delay the seen-stamp** (mark seen on a click inside the panel, not on open). Keeps the
  earned-slot rule, but then the badge lies: the user has read the panel and the number says
  otherwise.
- **Keep the pill for a grace period after being read.** A timer the user cannot see, and it only
  moves the disappearance a few seconds later, into the moment they reach for it again.
- **Bar slot always, even with zero traffic.** Rejected: spends a permanent header slot on boards
  where agents never talk, which is the header creep the manifest names as this app's top
  anti-pattern.
