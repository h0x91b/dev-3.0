# Notifications reach the traffic timeline through a normalized event, not through raw rows

## Context

`dev3 notify` history is persisted (`~/.dev3.0/notifications/YYYY-MM-DD.jsonl`, schema in
`src/shared/notification-log.ts`). Showing it on the Agent-traffic timeline was built in parallel
with two other tasks: one owning historical task projection and the shared `TrafficNodes` cursor,
one owning the traffic screen's route and shell. Three tasks, one timeline, and the cursor is a
single index into `TrafficRecord[]` — message rows only.

## Investigation

The archive on disk at the time of writing held exactly one day (`2026-09-08`, 20 rows). That is a
fact about the **retained** archive and nothing more: it does not establish when collection started,
and the reader must not infer one. What it does establish is that "30 days of retention" is the
policy, not the available range — a reader that assumed the policy would have invented three weeks
of history that does not exist.

Three facts about the rows are easy to get wrong and expensive to get wrong. A notification may
carry no task at all (`taskId: null`), and the card it was sent from (`sourceTaskId`) is not always
the card it points at — `dev3 notify --task <other>` addresses somebody else's card. Both nulls mean
"the archive did not record this", which is **not** the same as "there was no worktree"; claiming the
latter is inventing a fact about the caller. And `sourceSessionId` does **not** identify a
sub-agent: a Claude Code sub-agent inherits its parent's session id verbatim, which the schema's own
comment states as measured.

Fan-out is already de-duplicated at write time: `recordNotification()` in
`src/bun/cli-socket-server.ts` returns early on `params.fanout === true`, so only the instance the
CLI addressed records the row. A reader that de-duplicated again would be guarding a race that
cannot happen.

## Decision

**One normalizer owns the rules** — `src/mainview/components/agent-traffic/notification-event.ts`.
`notificationEvents()` turns rows into `TrafficNotificationEvent`: nulls stay null (an event with no
`target` is unanchored and belongs to no card), a `target` the board no longer has keeps its anchor
instead of being reassigned, suppression is carried only on a `queued` row, and a row whose `at`
cannot be parsed is dropped rather than dated to 1970.

**Selection is by TIME, not by index** — `notificationsAt(events, at)`. It is the only selection
that answers identically whether the cursor arrives playing forward, seeking backwards or after a
restart, and it stays correct when a live append lands behind the cursor.

**The union and its tie-break belong to the cursor's owner, not here.** This module briefly carried
its own `TrafficTimelineEvent`, `TIMELINE_KIND_RANK` and merge; they were deleted in favour of the
single declaration in `traffic-timeline.ts`, whose rank is `task: 0, message: 1, notification: 2` —
task first, because a card must exist before anything can point at it. What stays here is the one
arm this side owns, `TrafficNotificationTimelineEvent`, plus `notificationTimelineEvents()`.

**Keys count identical rows from the NEWEST end.** Two identical notifications must stay two events,
and the only thing telling them apart is how many identical rows sit beside them. The page is
truncated at `limit` from the *old* end, so counting from the oldest row in the page renumbers every
duplicate the moment a longer page reveals an older identical one — every key changes on "load
more", underneath the cursor. Counting from the newest end is stable under a refresh, a prepend and
a longer page alike. The first implementation had this backwards.

**The range is read off disk.** `NotificationLogPage` gained `newestDay` alongside `oldestDay`, so
the UI can say "recorded 09-06 — 09-08" and, on an empty archive, "nothing recorded on this machine
yet" — which is not the same statement as "nothing happened".

**Reads may be narrowed to a project allowlist** (`readNotificationLog({ projectIds })`), so a
project the user marked sensitive never puts its notification text on the wire, rather than being
filtered after it arrives. A row with no project is always kept: it belongs to nobody, and hiding it
would answer a different question.

**Cross-instance appends come from the filesystem, and the watcher is now shared.** The message
log's watcher was generalized into `src/bun/day-file-watch.ts` (`watchDayFiles`,
`noteLocalDayFileAppend`, `stopDayFileWatches`); `agent-message-log-watch.ts` is now only the
project binding, and its per-log aliases were deleted rather than kept next to the new names. The
awkward parts — macOS missing native events, a directory that does not exist yet, a day-file the
prune deletes underneath the watcher — are paid for once.

**A notification renders as a thought cloud over the card that sent it.** On the user's direct
instruction: a classic thought cloud, lobed edges and a trail of shrinking puffs, hanging above its
own card — not a rounded rectangle, and not on the edge line between two cards, which is where a
*message* belongs. A message has two ends; a notification has one, and it is addressed to the human.
`traffic-cloud.ts` computes the silhouette from the measured text (lobe circles plus a rectangle,
all wound the same direction and unioned by `fill-rule="nonzero"`; the rim is a second, slightly
grown copy painted behind, because stroking a union would draw every internal arc). Which card it
hangs over is `cloudSenderEndpoint()`: the sender, or nothing. There is deliberately no fallback to
the card the notification is *about* — a thought over a card that never sent it would invent a
sender out of a missing field, and a missing source is the archive not recording one rather than
evidence about who called. An unrecorded source stays unanchored, and the target is named in words
instead, which reads as a different claim because it is one.

**A temporary harness existed to prove that, and was removed.** `NotificationTrafficPreview`
(`?notificationPreview=1`) had mock cards and its own cursor so the cloud could be driven and
screenshotted before the shared stage existed. The screenshots and the replay video were captured,
then the component and its route were deleted: there must be no second product timeline.

## Risks

- **`TrafficNotificationTimelineEvent` must stay structurally identical to the union's
  `notification` arm.** Nothing enforces it across the two modules, so a rename on either side is a
  silent break until the compiler sees the merge call.
- **The cloud is measured, so it reflows.** Its size comes from a `ResizeObserver` on the text, and
  a font-size or locale change resizes every visible cloud. Cheap for the two or three on screen at
  once, and `max` in `notificationsAt` is what keeps that number small — raising it makes the reflow
  cost real.
- **`neverSeen` counts `queued` as possibly-unseen forever.** The archive records that delivery was
  held back at that moment and never records whether the later flush was seen, so the count is
  honest but permanently pessimistic.
- **`stopDayFileWatches()` now stops every log's watches, not one log's.** Only shutdown calls it,
  where that is what was wanted anyway, but a future per-log stop would need a new parameter.

## Alternatives considered

- **Fold notifications into `AgentMessageLogRow`.** Rejected: a message always has a recipient task
  and a notification may have none, so every consumer would gain a null check on a field the type
  says is present. The two logs also have separate directories and separate retention clocks.
- **Index-based cursor selection, matching the message timeline.** Rejected: an index is a position
  in one array, and the moment a second stream is merged the same index means two different
  instants. Backwards seek and live appends both break.
- **Filter sensitive projects in the renderer**, as the traffic surface does for messages. Rejected
  here because the message log is read per project (so a locked project is never fetched), while the
  notification archive is one global file — filtering after the read would have put the text on the
  wire first.
- **Duplicate ~120 lines of the filesystem watcher for notifications.** Rejected: the hard parts are
  platform quirks, and two copies would diverge exactly where a quirk is fixed once.
