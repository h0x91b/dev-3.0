# Append-only agent message log, partitioned by day

## Context

Agent-to-agent messages left no trace. `dev3 message` types straight into the
recipient's pane; the only record was a transient `agentMessage` push rendered as
a 30-second toast carrying a 60-character preview. Scheduled messages live in
`Task.scheduledMessages` and are deleted on delivery. A user who stepped away for
a day could not reconstruct what a coordinator and its workers said to each other,
and no UI could ever show a task-to-task traffic graph. This also blocks the 3D
coordinator-traffic visualization concept (task Seq 1648).

This change writes a new file tree under `~/.dev3.0/`, which walks straight into
the frozen on-disk invariants in [`AGENTS.md`](../../../../AGENTS.md#on-disk-data-layout--hard-invariants-mandatory):
that directory is shared with every installed version of the app on the machine,
`projectSlug()` is frozen, and neither renames nor destructive load-time
migrations are allowed. The record of that rule being learned the hard way is
[`revert-project-slug-dash-escape`](../../../04/20/revert-project-slug-dash-escape.md),
where a slug change plus a startup rename left an older app version staring at an
empty Kanban board.

## Investigation

Three questions decided the shape.

**Where does a row get written?** `deliverToTarget` in
`src/bun/scheduled-message-scheduler.ts` is documented as the one seam shared by
immediate `dev3 message` sends and queued "Send later" fires — the obvious hook.
It turned out to be the wrong one: `fireScheduledMessage` drops a message for a
finished task *before* calling it, so a log hooked there would have been silent on
exactly the case a user investigating a silence needs. Logging therefore happens at
the two outcome points (`recordMessageAttempt`, called from `fireScheduledMessage`
and `sendMessageImmediately`), where a final `AgentPromptDelivery` exists.

**Can a single `messages.jsonl` be trimmed?** No, not while staying append-only.
The only way to trim one file is to rewrite it, and a rewrite loses rows whenever
two app instances do it at once — the installed app plus a dev build a task's
`devScript` booted is the normal state of this machine, not an edge case.

**Is a concurrent append safe?** Yes, while one row is one `write()`. A file opened
`O_APPEND` has its seek-and-write serialised by the kernel, so two processes cannot
overwrite each other's bytes; a buffer large enough to be split by a short write
could tear a line across another. Bodies over `AGENT_MESSAGE_SPILL_THRESHOLD_BYTES`
(4 KB) already travel as a spill-file pointer, so real rows sit far below the cap.

## Decision

`~/.dev3.0/data/<projectSlug>/messages/YYYY-MM-DD.jsonl` — one append-only file
per project per local day, in a NEW directory beside the existing `tasks.json`.
Nothing is renamed, nothing is migrated, and an older app version simply never
opens the directory. `projectSlug()` is used as-is, untouched.

- **Writer / reader / retention:** `src/bun/agent-message-log.ts`
  (`appendAgentMessageLog`, `readAgentMessageLog`, `pruneAgentMessageLog`). One row
  is one `appendFileSync` at mode `0600`. Appending never throws — a message that
  was delivered must not be reported as failed because a log write hit a disk error.
- **Row shape:** `src/shared/agent-message-log.ts` — pure and shared, so the writer,
  the reader and the renderer cannot disagree about what a row means. Rows are
  capped at `AGENT_MESSAGE_LOG_MAX_ROW_BYTES` (8 KiB); an oversized row shrinks its
  `body` and keeps every metadata field, because a row whose recipient or verdict
  had been dropped would be worthless to a traffic graph.
- **Retention:** `AGENT_MESSAGE_LOG_RETENTION_DAYS = 30`. Expired day-files are
  deleted whole — no rewrite, no rename. Pruning runs from the write path, at most
  once per day per project, mirroring `pruneLogFiles` in `src/bun/logger.ts`. The
  reader returns `oldestDay` and `retentionDays`, so trimmed history reads as
  trimmed rather than as silence.
- **Call site:** `recordMessageAttempt` in `src/bun/scheduled-message-scheduler.ts`.
  Every attempt is recorded, `not-delivered` included.
- **Read path:** the `readAgentMessageLog` RPC in
  `src/bun/rpc-handlers/notes-labels.ts`. `ScheduledMessage.spilledPath` was added
  so a row can state that it holds a pointer instead of guessing from the wording.

## Risks

- **Message bodies land on disk unencrypted**, exactly as the agents wrote them,
  including paths and anything a human pasted by mistake. The file is `0600`, the
  same as the native-terminal stream taps, and nothing is filtered: a redacted
  traffic log would not answer the question it exists for. 30 days is the bound.
- **A spill pointer can outlive its file.** Oversized bodies are written into the
  task directory, which dies with the task on cleanup. An old row's `spillPath` may
  name a file that is gone; the row then documents that a large message was sent,
  and nothing more.
- **A row is written after delivery, so an app killed mid-send logs nothing.** The
  window is milliseconds, and the alternative — a row written before delivery —
  would claim traffic that never happened.
- **Seq 1655 is moving the delivery boundary** to hold a message's text in memory
  until the human stops typing. A message held in that window is owed to a recipient
  and not yet delivered, and this log deliberately cannot express that state. See
  "Alternatives considered".
- **A day boundary is local time**, so a day-file straddles a timezone change. It
  costs at most one mis-filed row and keeps the convention `logger.ts` already uses.

## Alternatives considered

- **One `messages.jsonl` per project, compacted when it grows.** What the original
  request named. Rejected: compaction is a whole-file rewrite, which is not
  append-only and loses rows when two app instances run it concurrently.
- **One `messages.jsonl`, rotated to `messages.1.jsonl`.** Rejected: a rotation is a
  rename under `~/.dev3.0/`, and the invariants forbid renames there outright rather
  than case by case.
- **A per-task file.** Rejected: traffic is *between* tasks, and a per-task file
  cannot be read as a graph.
- **SQLite.** Rejected: a new binary format two app versions must agree on, with
  cross-process locking, to replace a text file the user can `tail`.
- **Recording held (not yet delivered) messages.** Deliberately out of scope, not
  designed out: the row already carries `status`, so a `held` value plus an amending
  row would express it without a schema break. It needs a second file, because a
  pending row must be removable and this one is append-only — and Arseny has already
  accepted losing a held message when the app dies. Left for its own decision.
