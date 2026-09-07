# The notification history is one global log, not a per-project one

## Context

`dev3 notify` was the loudest thing an agent could do and the only one that left
no trace: a toast lives seconds, an OS notification dies on dismissal, and one
sent during Focus Mode may never be seen at all. The plan is to show notification
events in the agent-traffic timeline, but only after a couple of days of real
data — so this change collects and shows nothing.

The obvious home was the agent message log (`~/.dev3.0/data/<slug>/messages/`),
which already solved day-files, retention and concurrent appends.

## Investigation

Two facts ruled that shape out. A notification can be sent with no task at all
(`dev3 notify "done"` from any shell), so there is no project to file it under —
per-project storage would silently drop exactly the calls a human makes. And a
notification is addressed to the human, while a message is addressed to another
task's agent and always has both ends; folding one into the other would make
both unreadable.

A third fact shaped the outcome field rather than the location: `dev3 notify`
fans the same toast out to every live dev3 instance so it reaches whichever app
the user is looking at. Without a marker each instance would record the same
notification, turning one ping into N rows.

## Decision

`~/.dev3.0/notifications/YYYY-MM-DD.jsonl` — a new top-level directory beside
`data/` and `logs/`, nothing renamed and nothing migrated, so an older installed
version simply never opens it (AGENTS.md on-disk invariants). Every row carries
its own `projectId`, so a per-project view is a filter rather than a layout.

- Schema, clamping and parsing: `src/shared/notification-log.ts`.
- Writer, day-files and 30-day pruning: `src/bun/notification-log.ts`.
- Call site: the `ui.notify` handler in `src/bun/cli-socket-server.ts`, via
  `buildNotificationLogBase` and `recordNotification`.
- The CLI (`src/cli/commands/ui-control.ts`) adds `sourceTaskId` (the worktree
  the command ran in, which is not the same fact as the task it points at),
  `sourceSessionId`, and `fanout: true` on the duplicate deliveries.

Three deliberate limits:

- **The outcome is recorded, not guessed.** `delivered`, `queued` (with the
  suppression sources that held it) and `no-window` are separate answers. What
  the user did with a delivered notification is not knowable and is not stored.
- **A silenced project writes no row at all.** `deliverTaskNotification` drops a
  silenced project's notification so it leaves no trace on screen, "now or after
  streamer mode goes off". A log the timeline will later render would put that
  trace back, so the row is not written.
- **Sub-agent provenance does not exist and is not faked.** Measured, not
  assumed: a Claude Code sub-agent inherits its parent's `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_PID` and `CLAUDE_CODE_CHILD_SESSION` verbatim, so nothing in the
  environment separates them. `sourceSessionId` separates two agent sessions in
  one task and nothing finer; every other harness leaves it absent.

## Risks

An older `dev3` binary against a newer app sends no `fanout` marker, so a
multi-instance notification would record one row per instance until the CLI
catches up (it self-installs from the app, so the window is short). Rows are
plain text at `0600` including whatever an agent wrote into a message — the same
privacy posture as the message log, and nothing here has a telemetry path.

## Alternatives considered

Per-project files under `data/<slug>/notifications/`, rejected because a
task-less notification has no project. A single append-only `notifications.jsonl`,
rejected because trimming it means rewriting it, which stops being append-only
and loses rows when two instances trim at once. Writing the row in the CLI
process instead of the app, rejected because only the app knows the outcome —
whether a window existed and whether suppression held it back.
