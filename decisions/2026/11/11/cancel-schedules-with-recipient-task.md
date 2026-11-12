# Cancel scheduled messages when their recipient task ends

## Context
A self-reminder queued while its task was running fired after completion and raised a red delivery error. A planned end to a task is cancellation of its future work, not an unexpected delivery failure.

## Investigation
`src/bun/lifecycle/executor.ts` cleared `scheduledMessages` on reset to To Do but retained it in `persistTerminalTask`. `fireScheduledMessage` skipped delivery for finished tasks but still emitted the generic missing-agent toast and attention; the spill body lived beside the worktree and survived its removal.

## Decision
`persistTerminalTask` clears the recipient's queue in the same write as completion or cancellation. `src/bun/scheduled-message-scheduler.ts` silently removes legacy queues on finished tasks, including future items, while retaining their not-delivered attempt in the message log. A sender ending does not invalidate a message queued on another live recipient; existing agent-bound routing and active-task failure notifications still apply.

## Risks
Pending messages disappear when their recipient ends, and reopening that task does not restore them. An already-held or in-flight delivery cannot be recalled by clearing the pending queue; this change does not promise cancellation after dispatch. No paths, data formats, or message files are renamed or deleted.

## Alternatives considered
Only dropping silently at due time leaves stale queue chips and allows reminders to reach a later run if the task reopens early. Delivering to a replacement agent or cancelling every outgoing message when its sender ends changes the intended recipient or loses useful cross-task reports. Cancel at recipient completion and silently clean legacy leftovers instead.
