# Replay pending completion dialogs to a renderer when it connects

## Context

An agent-initiated completion request (`dev3 task move --status completed`) blocks the CLI for up
to 10 minutes while the user answers a dialog. The request lives in `pendingByRequestId`
(`src/bun/agent-requests.ts`); the dialog lives *only* as a React `confirm()` promise inside
whichever renderers were connected when `agentCompletionRequested` was pushed.

That push is a one-shot event. A renderer that goes away before answering — a remote-browser tab
refresh is the cheap case — takes the only copy of the dialog with it. The entry survives, and
because `createAgentRequest` de-duplicates on `complete:<taskId>` and *joins* an existing promise,
every later retry attaches to a request that no client will ever draw. Unlike `launch`, the
`complete` kind deliberately has no auto-approve timer (`cli-socket-server.ts`: "A launch is
reversible… The completion dialog deliberately does not do this — it destroys a worktree"), so
nothing ever expires it. Net effect: that task can never raise a completion dialog again for the
rest of the app session, and each agent attempt burns a full 10-minute block with no explanation.

## Investigation

Found while refuting an unrelated report (task 4ebac127 / Seq 1696) and reproduced before any fix:
a request pushed to renderer A, then a fresh renderer B, a retry that pushes nothing to B, and 24
hours of fake clock with both callers still blocked and `moveTask` never called. A control proved
the clock itself works — a request created *with* `autoApproveAfterMs` settles under the same
advance — and a mutant that added `autoApproveAfterMs` at the `complete` call site turned the
reproduction red on exactly the "no expiry" assertion, then green again when removed.

Browser QA on a scoped `--qa` board corrected one thing and found another. A **graceful** tab
reload does not orphan the request: the reloaded page replays it, and the trigger for an orphan is
an **ungraceful** loss of the renderer — verified by killing the browser outright, after which the
blocked CLI was still waiting with nothing on screen anywhere. And the first cut of this fix turned
that orphan into a silent auto-decline: `confirm()` is fail-closed, so replaying before
`ConfirmHost` had mounted resolved `false` with no dialog drawn and told the agent the user had
declined a dialog nobody ever saw. That is why the replay now waits for
`whenConfirmHostMounted()` and skips rather than answering if the host never appears.

An app *quit* does **not** produce this bug: the map is in-memory, so the process death takes the
request with it, the blocked CLI sees `Empty response from server` immediately
(`src/cli/socket-client.ts`), and its retry creates a genuinely new request. Verified in
`~/.dev3.0/logs/2026/08/2026-08-22.log`, where pid 90303 held two pending completion requests and
quit at 21:14:25 with a fresh pid up three seconds later.

## Decision

The renderer asks, rather than the backend guessing. `createAgentRequest` now stores the dialog
payload (`AgentRequestDialog`: title + `TaskDialogSubject`) on the pending entry, and
`listPendingAgentRequests(kind)` exposes the unanswered ones. A new RPC,
`listPendingCompletionRequests` (`src/bun/rpc-handlers/task-lifecycle.ts`), returns them, and
`App.tsx` calls it once the completion-dialog effect is listening, feeding each through the same
`showCompletionDialog` routine the push uses. A ref-held set of request ids keeps the push and the
replay from stacking two confirms for one request.

Deliberately unchanged: no expiry and no auto-approval for `complete`. A completion still happens
only because a human clicked approve.

## Risks

- A pending request whose CLI has already timed out is still replayed, so the user may be asked
  about a request nobody is waiting on. Approving it completes the task, which is what the dialog
  says it does — but the agent will not see the answer. Accepted: the alternative is tracking
  socket liveness per request, which is a much larger change for a narrower win.
- The replay fires on every re-run of that effect, not strictly on connect. The id set makes the
  extra calls no-ops; the cost is one cheap in-memory RPC.
- An app restart still strands nothing but also recovers nothing — see below.

## Alternatives considered

- **Give `complete` a TTL.** Cheap, but it must never auto-approve (worktree destruction), so it
  could only auto-*decline* — which silently refuses a completion the user never saw, and loses
  the request anyway. Rejected.
- **Drop the request when its renderer disconnects.** Requires per-client ownership the request
  layer does not have, and would kill a request that a *second* connected window is still showing.
- **Persist pending requests across an app restart.** Rejected as actively harmful: after a
  restart the requesting CLI is already dead (it got `Empty response from server`), so approving a
  restored dialog would complete a task with no agent waiting on the answer.
