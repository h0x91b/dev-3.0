# Notifications as a third arm of the replay timeline

## Context

The Agent traffic replay walked a union of two recorded facts — board movements
and agent messages. `dev3 notify` history became readable over RPC
(`readNotificationLog`, `src/bun/notification-log.ts`) with a renderer store and
a normalizer already in place, and the screen already carried `notification` as a
kind-filter control value with no arm behind it.

## Decision

`TrafficNotificationTimelineEvent` is the third arm of `TrafficTimelineEvent`
(`src/mainview/components/agent-traffic/traffic-timeline.ts`), carrying the
normalizer's event verbatim — its key and instant included, so nothing is minted
twice. `useNotificationTraffic` decides when to read and which projects the read
may touch; `AgentTrafficScreen` feeds the arm into all three `buildTimeline`
calls and renders notification rows in the existing inspector list.

Three rulings worth writing down:

1. **Tie rank is `task` → `message` → `notification`** (`TIMELINE_KIND_RANK`). A
   notification is about a card, so it shares the message's constraint of never
   landing before the card exists; putting it after the message reads as the
   consequence of the work the message asked for, and a tie has to break
   somewhere written down.
2. **An unanchored notification belongs to no board.** With no project recorded
   at either end it counts for no project in `activeProjectIds`, so it appears
   under `All projects` and not under a named or `active` scope. Attaching it to
   a nearby board to keep it on screen would invent the one fact the archive
   exists not to invent.
3. **The read waits for the visible-project list.** `useNotificationTraffic`
   takes `null` for "not established yet" and stays `idle` rather than reading
   unscoped, because an unscoped read puts a sensitive project's notification
   text on the wire before anything can filter it.

   `status` exists because "not loading" is **also** true before the first read
   has been asked for, so the two states must stay distinguishable. It gated the
   screen's one-shot entry autoplay until that latch was deleted (entry is Live
   with Follow now — `decisions/2026/09/10/agent-traffic-enters-live-not-replaying.md`),
   and it feeds the screen's loading readout instead: a screen saying `Live`
   while the archive is still being read claims to show everything that just
   happened with a whole kind of event still missing. Any future one-shot gate on
   the archive must wait for `ready` or `failed`, never for the absence of
   loading.

`resetNotificationTrafficStore` now bumps its load version instead of resetting
it to zero: a read in flight across a reset otherwise matched the next read's
version and patched the fresh store with the pre-reset page.

## Risks

The replay walks a snapshot, so a notification appended mid-replay appears only
after Replay/Live — deliberate, and the same as messages. The search box narrows
notifications on their own text; the delivery filter deliberately does not apply
to them, so a reader narrowing to `delivered` messages still sees notifications.

## Alternatives considered

Rendering notifications as a separate list or a fourth tab: rejected, it splits
one chronology into two and the reader has to merge it by eye. Folding a
notification into the message arm as a pseudo-message: rejected, it would fake a
sender and a delivery verdict the archive never recorded.
