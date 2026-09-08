# Notifications reach the traffic timeline through a normalized event, not through raw rows

## Context

`dev3 notify` history is persisted (`~/.dev3.0/notifications/YYYY-MM-DD.jsonl`, schema in
`src/shared/notification-log.ts`). Showing it on the Agent-traffic timeline was built in parallel
with two other tasks: one owning historical task projection and the shared `TrafficNodes` cursor,
one owning the traffic screen's route and shell. Three tasks, one timeline, and the cursor is a
single index into `TrafficRecord[]` — message rows only.

## Investigation

The archive on disk at the time of writing held exactly one day (`2026-09-08`, 20 rows). Collection
started when the writer shipped, so "30 days of retention" is the policy, not the available range —
a reader that assumed the policy would have invented three weeks of history that does not exist.

Two facts about the rows are easy to get wrong and expensive to get wrong. A notification may carry
no task at all (`taskId: null`), and the worktree it was called from
(`sourceTaskId`) is not the card it points at — `dev3 notify --task <other>` addresses somebody
else's card. And `sourceSessionId` does **not** identify a sub-agent: a Claude Code sub-agent
inherits its parent's session id verbatim, which the schema's own comment states as measured.

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

**The union and its tie-break are declared once** — `TrafficTimelineEvent` plus
`TIMELINE_KIND_RANK` (a literal, so adding an arm cannot silently reorder a replay) and
`mergeTrafficTimeline()`, which sorts by `at`, then rank, then key. Keys carry an occurrence index,
so two identical notifications stay two events and a prepend cannot renumber older ones.

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

**A standalone preview surface exists on purpose.**
`NotificationTrafficPreview` (`?notificationPreview=1`, mounted in `main.tsx`) has its own cursor
so the bubbles are drivable and verifiable while the shared cursor is owned elsewhere. It adds no
navigation and leaves no trace without the parameter. It is a harness, not a product surface; the
shared wiring replaces it.

## Risks

- **The union's `task` arm is declared here but constructed elsewhere.** If the owner of historical
  projection picks a different discriminant, the rank map and the merge need re-pointing. Cheap, but
  it is a coupling that exists only until the contract is settled.
- **Two cursors while the preview lives.** Nothing keeps them in sync, deliberately — but a reader
  who finds both could mistake the harness for the real surface. Its module comment says so.
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
