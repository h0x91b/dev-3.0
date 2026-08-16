# A no-op task update skips the write

## Context

On 2026-08-16 the app froze. In the last three minutes before the user killed it,
`data.updateTaskWith` logged 1005 writes for a single task, ~11 per second, all
for the same Codex task on the base44 board — whose `tasks.json` is 14 MB across
498 tasks. The same storm had run 613 times earlier that morning (07:01-07:08),
alongside 1896 `Lock acquisition timed out` warnings across the day.

The huge `Event loop stall detected` warnings in that log (933 s, 624 s, 424 s)
are NOT related: each one matches a macOS clamshell-sleep window one-to-one in
`pmset -g log`. The detector measures wall clock and cannot tell a blocked thread
from a sleeping machine, so the real stall — the write storm — barely showed up in
it. Do not trust that warning as a freeze signal until it is fixed.

## Investigation

`captureCodexPaneSession` (`src/bun/cli-socket-server.ts`) runs on every Codex
lifecycle hook and calls `data.updateTaskWith`. Its mutator correctly returns
`{ updates: {}, result: { changed: false } }` once the session id is recorded —
but `updateTaskWith` called `rawSaveTasks` unconditionally, so every hook cost a
strict re-parse plus a full serialize and atomic write of the whole board.

## Decision

`applyTaskUpdate` (`src/bun/data.ts`) now returns `{ task, changed }` and reports
`changed: false` for an empty patch or a blocked status guard; `updateTask`,
`updateTaskWith` and `setTaskTerminalBackend` save only when it is true. This
matches what `setTaskPriority` and `setTaskTerminalBackend` already did by hand.

On top of that, `captureCodexPaneSession` answers its steady-state no-op from the
cached read (`codexPaneSessionAlreadyRecorded`) before taking the file lock, so a
repeat hook does not even re-parse the board strictly.

Guarded by `src/bun/__tests__/data-noop-write.test.ts` and a new case in
`cli-socket-codex-capture.test.ts`; both assert on the file's inode, since atomic
saves rename into place and therefore land a new inode on every real write.

## Risks

An empty patch no longer bumps `updatedAt`. Nothing used `updateTask(task, {})` as
a touch, and a timestamp nobody changed has no reader. A patch whose values merely
equal the current ones still writes — deep-comparing every field would cost more
than the write it saves.

## Alternatives considered

Debouncing the Codex hook: hides the cost instead of removing it, and every other
`updateTaskWith` caller keeps paying it. Shrinking `tasks.json`: worth doing, but
it lowers the price of a pointless write rather than skipping it.
