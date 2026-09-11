# The live notification preview needs its own arrival path, not a cursor

## Context

`decisions/2026/09/11/notification-preview-cloud-on-sender-card.md` added the cloud that
previews an archived notification over the card that sent it. It reads `playback.current`,
which only ever names an event while a replay cursor is standing on one. In Live Follow
`useTrafficPlayback` keeps `index === -1` and `current === null`, so a notification arriving
while the user watches the stage showed nothing at all.

## Investigation

Messages already have a second, live-only arm that has nothing to do with the cursor: an
effect diffs `layoutRecords`, launches a flight for any record younger than 10 s while not
replaying, and lets the flight resolve the bubble. There is no cursor involved, and that is
what makes it work in Live. The notification arm had no equivalent.

## Decision

Mirror that effect for notifications in `TrafficNodes.tsx`: diff `playback.events` filtered
to `kind === "notification"` against a seen-set held in a ref, take the newest arrival that
is both unseen and younger than `LIVE_NOTIFICATION_FRESH_MS` (10 s), hold it in
`liveNotification`, and clear it after `LIVE_NOTIFICATION_MS` (6 s). `activeNotification`
now reads the cursor while replaying and `liveNotification` otherwise, so replay behaviour is
unchanged.

Three things are deliberately silent, and all three fall out of the same two guards. The
first pass only seeds the seen-set, so opening the screen on a full archive previews nothing.
The set keeps seeding while replaying, so returning to Live does not replay what fired
meanwhile. The freshness window covers a refetch that re-delivers old rows and a reconnect
backlog, neither of which is a new arrival in time.

No camera work, no placement engine, no new controls: an arrival from an off-frame or
unrecorded sender still shows nothing, exactly as in replay.

## Risks

Two lifetimes now exist side by side — the cloud's 6 s and the message flight's 2.4 s — so a
notification can outlive the bubble of the message that caused it. That is preferred to
matching them: a notification is read as text and needs longer than a travelling dot.

A rapid burst collapses to one preview: each arrival replaces the previous one and restarts
the timer, the same single-slot rule the completion celebration already uses. A queue would
walk the stage through a backlog long after the moment.

## Alternatives considered

Moving the live cursor onto arrivals — rejected: `index` is the replay cursor, and driving it
from Live would make the scrubber, the projections and the visible-message cut-off all move
on their own.

Pushing the arrival straight from `rpc:notificationLogChanged` — rejected: the event carries
no row, and reading the archive a second time beside the store would bypass both the project
privacy scoping and the kind filters that `playback.events` has already applied.
