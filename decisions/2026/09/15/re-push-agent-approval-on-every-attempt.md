# Re-push an agent approval request on every attempt

## Context

`dev3 task move --status cancelled` (and `completed`, and an agent-initiated
launch) blocks the CLI until the user answers a dialog in the app. Issue
[#1669](https://github.com/h0x91b/dev-3.0/issues/1669) was first read as
overlapping dialogs displacing each other and fixed by giving `ConfirmHost` a
queue (`decisions/2026/09/08/queue-overlapping-confirm-dialogs.md`). The reporter
reopened it on a build that already had that fix: the dialog surfaced only when
the *requesting* task was focused, and three further attempts each blocked the
full ten minutes with nothing on screen.

## Investigation

On a two-project scoped QA board (`DEV3_QA_SCOPE=seeded`), driven from a browser
client, a **fresh** cross-project cancel draws its dialog fine from the dashboard
and from the other project's board — focus changes nothing. The failure needs a
second attempt:

```
08:09:00 [agent-requests] Created agent request {"kind":"cancel","taskId":"fc6d8f13",...}
08:09:59 [agent-requests] Joining existing agent request {"kind":"cancel","taskId":"fc6d8f13",...}
```

The second line pushed nothing. `createAgentRequest` dedups on `<kind>:<taskId>`
so a retry joins the live request, and every call site pushed the dialog only
`if (isNew)`. Once a client lost that one push — it had not connected yet, its
transport dropped, the window reloaded mid-flight, or the dialog was displaced —
the request was unreachable from the CLI for the rest of the app session: the
only remaining route back to a user was `listPending*Requests`, which a client
asked for exactly once, on mount. So nothing the agent did could help; only a
newly connected client could.

That the reporter hit *this* gap is inference, not a reproduction: the sequence
above was constructed here to exercise the path, and their host log and client
state are not available. It fits their account — silent retries, then three
approvals once they touched the app — and the gap is reachable regardless, which
is what justifies the fix.

## Decision

1. `src/bun/cli-socket-server.ts` pushes `agentCompletionRequested`,
   `agentCancellationRequested` and `agentLaunchRequested` on **every** attempt,
   joined retries included. Clients dedup on `requestId`
   (`cancellationDialogsShowingRef` / `completionDialogsShowingRef` in `App.tsx`,
   the launch queue), so a dialog already on screen is untouched and one answer
   still settles every blocked caller. `createAgentRequest` no longer returns
   `isNew` — nothing consumes it.
2. `App.tsx` replays `listPendingCompletionRequests` / `listPendingCancellationRequests`
   on every `RPC_STATUS_EVENT` → `connected`, not only on mount, so a transport
   that dropped while the request was created recovers without a page reload.
3. `src/cli/commands/task.ts` only claims "this session will be destroyed" when
   the approval targets the session's own task (`targetsOwnSession`, proof-based:
   an unresolvable `seq:N` counts as not proven). Other targets get wording about
   *that* task's worktree.

Consent policy is untouched: nothing auto-approves, nothing shortens the wait,
and the ten-minute CLI timeout is unchanged.

## Risks

- A retrying agent now makes a dialog reappear on a client that never had it. It
  cannot stack (requestId dedup) and it cannot re-arm a launch countdown
  (`markAgentRequestShown` only re-arms on first display), but a user who walked
  away from one client will find the dialog waiting on another. That is the
  intent.
- `targetsOwnSession` is deliberately conservative: addressing your own task as
  `seq:N` gets the neutral wording. Under-warning was chosen over the false
  claim that was there before.

## Alternatives considered

- **Push only when no client has shown the request** (`shownAt` is already on the
  entry). Rejected: `shownAt` is per-request, not per-client, so a client that
  connected after the only display would still never be told.
- **Have the host re-broadcast pending requests on a timer.** Rejected: a
  heartbeat that redraws destructive dialogs is worse than one tied to an actual
  agent attempt.
- **Drop the approval for a To Do task with no worktree** (the reporter's own
  alternative). Rejected again: that is a consent-policy change, not a delivery
  fix.
