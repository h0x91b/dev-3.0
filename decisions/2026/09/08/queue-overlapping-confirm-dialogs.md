# Queue overlapping confirm dialogs instead of replacing them

## Context

`ConfirmHost` (`src/mainview/confirm.tsx`) held a single pending confirm in
`useState`, and `confirm()` handed every new request to that same setter. A
second call therefore overwrote the first: the visible dialog was replaced
mid-question and the displaced promise was never resolved by anyone.

For a user's own click that loses a prompt. For an agent-initiated request it is
worse, because the promise is what a blocked CLI is waiting on. Reported as
issue #1669 as "cross-project `task move --status cancelled` approval dialog
never surfaces".

## Investigation

Reproduced on an isolated two-project QA board (`DEV3_QA_SCOPE=seeded`), target
task in To Do with no worktree and no branch, driven through the browser client:

1. First `dev3 task move --project B --task seq:N --status cancelled` — dialog
   appears. So neither delivery nor any project filter is at fault; the intake's
   reading that there is no active-project filter in the handler is correct.
2. A second cancellation request for a different task replaces the dialog on
   screen. The first dialog is gone and its CLI stays blocked.
3. Answering the second leaves zero dialogs. The first never returns:
   `cancellationDialogsShowingRef` in `App.tsx` still holds its `requestId`
   (the `finally` that clears it never runs, because the promise never settles).
4. Retrying the first cancellation draws nothing and blocks for the full ten
   minutes — `createAgentRequest` dedups on `cancel:<taskId>` and only pushes
   when `isNew`, so a retry joins the orphaned entry.

That is the reported symptom set exactly. Cross-project is incidental: the same
sequence strands a same-project request.

## Decision

`ConfirmHost` keeps a FIFO queue and renders the head. `confirm()` appends;
answering the head promotes the next. A queued entry whose caller aborted
(answered on another window) is resolved where it stands rather than promoted,
so no dialog flashes that nobody can act on.

This mirrors the deliberate queue the agent-launch dialog already uses in
`App.tsx` ("Queued, never stacked"), so it is the established pattern here
rather than a new one. Nothing about approval policy, timeouts, or the server's
request registry changes.

Guarded by `src/mainview/__tests__/confirm.test.tsx` ("overlapping confirms"),
verified to fail when the host is reverted to a single slot.

## Risks

A dialog can now appear later than the event that raised it — that is the point,
but it does mean two agent requests arriving together are answered in order
rather than the newest winning. The queue is in-memory, so a renderer reload
still drops it; the existing `listPending*` replay on connect covers that.

## Alternatives considered

- **Re-push on a joined retry** (`agent-requests.ts`): would let a retry redraw a
  lost dialog, but leaves the promise leak in place for every other `confirm()`
  caller, and that file is owned by another task.
- **Stack dialogs** rather than queue: overlapping modals make the user answer
  the wrong one, which is why the launch dialog queues.
