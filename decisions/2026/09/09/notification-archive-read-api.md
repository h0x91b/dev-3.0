# Notification archive: a read API before anything renders it

## Context

`dev3 notify` has been appending every notification to `~/.dev3.0/notifications/YYYY-MM-DD.jsonl`
since the writer shipped, and nothing could read it back. A first attempt bundled the reader with a
timeline, a level filter, a bubble component and a placement engine in one branch; the size was
rejected and the work was split, with this task taking the data half and the presentation halves
going to their own tasks.

## Decision

Three pieces, all data:

- `readNotificationLog` in `src/bun/notification-log.ts` — newest-first paging over the day-files,
  skipping torn and unparseable lines. `projectIds` is a **visibility allowlist applied during the
  read**, not a display filter, so a project the user marked sensitive never puts its notification
  text on the wire. A row with **no** project is always kept: a notification sent from a plain shell
  belongs to nobody, and hiding it would answer a different question than the caller asked.
- `readNotificationLog` RPC (`src/shared/types.ts`, handler in `rpc-handlers/notes-labels.ts`) plus
  the renderer store `src/mainview/notification-traffic.ts`, which caches one page and refreshes on
  `notificationLogChanged`.
- `src/mainview/notification-event.ts` — normalization, and the three rules that are cheap to get
  wrong: an unrecorded source invents nothing (`taskId: null` means the archive did not record it,
  not that there was no task); a claimed source is not an identity (`sourceSessionId` separates two
  sessions, and a Claude Code sub-agent inherits its parent's id verbatim, measured); and a request
  is not its fate (`queued` / `no-window` must never fold into `delivered`).

Two things were deliberately left out. **Only this instance's own appends are announced** — learning
about another running instance's writes needs a filesystem watcher, which a pull API does not, so
the watcher belongs to whichever task needs live refresh. And the store **ships with no React
caller**: the consuming hook belongs with timeline consumption. It is pending a consumer, not dead
code, and no UI was added here to make it look used.

## Risks

An empty archive and a trimmed archive must not look alike. The page carries `oldestDay`,
`newestDay` and `retentionDays`, and both days null means "collection never started here" rather
than "nothing happened"; a reader that assumed 30 days of history would invent the difference.

The store having no caller will read as dead code in review. That is the recorded cost of keeping
this slice small.

## Alternatives considered

Returning raw rows and letting each consumer interpret them — rejected because the three rules above
would then be re-decided at every render site, and one of those decisions would be wrong.

Shipping the filesystem watcher with the reader — rejected: it is a live-update mechanism, unrelated
to reading, and it refactors the pre-existing agent-message watcher along the way.
