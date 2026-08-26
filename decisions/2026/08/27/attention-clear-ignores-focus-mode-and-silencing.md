# `dev3 attention --clear` ignores Focus Mode and project silencing

## Context

`dev3 attention "reason"` lights the red task-card badge; reasons accumulate (newest 5 kept)
and the badge only came down when the user opened the task. There was no inverse command, so a
badge raised during an incident kept showing stale reasons long after the incident ended.

## Investigation

The badge is renderer state only (`bellCounts` / `bellReasons` in `src/mainview/state.ts`) — no
disk, no `Task` field. Raising it is gated twice: `pushCliAttention`
(`src/bun/rpc-handlers/shared.ts`) queues the push while Focus Mode or immersive terminal
suppression is active, and `App.tsx` drops it when the project is silenced for streaming.

## Decision

`dev3 attention --clear` (`handleAttention` in `src/cli/commands/ui-control.ts`) sends
`ui.attention` with `clear: true`. The socket handler (`src/bun/cli-socket-server.ts`) pushes
`cliAttention` with `clear: true` **without** consulting either gate, and calls
`dropQueuedAttention` (`src/bun/rpc-handlers/shared.ts`) to remove the task's queued attention
calls *and* queued terminal bells — both light the same badge, so a clear that spared them
would let the badge reappear at the next flush. `App.tsx` dispatches `clearBell` for the task,
also bypassing the silencing check. Clearing displays nothing, so neither gate protects
anything here; both would only keep a stale badge alive.

`--clear` takes no reason. A "resolution reason" that replaced the accumulated list was
rejected: it keeps the badge lit, which is the exact failure this command exists to fix.
`--clear "text"` parses as `clear="text"` in the CLI's flag parser, so a valued `--clear` is a
usage error rather than a silently swallowed argument.

## Risks

Clearing while the project is silenced on camera is invisible to the user until they leave
streamer mode — acceptable, since the alternative is a badge nobody can lower. An agent could
clear a badge the user has not seen yet; that is the same trade-off `dev3 attention` already
makes in the other direction.

## Alternatives considered

- **Resolution reason replacing the list** — rejected, badge stays lit.
- **Both `--clear` and a resolution reason** — rejected as two spellings for one job.
- **Honouring Focus Mode / silencing on clear** — rejected: it would queue a clear behind the
  badge it is meant to remove.
