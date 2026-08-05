# 210 — A bug hunter launch lives or dies by its prompt's verdict, on both backends

## Context

`spawnBugHuntersInTask` opens N panes and types the hunt prompt into each. The native
arm already undid the whole launch when a prompt did not land; the tmux arm fired two
`send-keys` calls per pane from nested `setTimeout`s with `bestEffort: true`, and a
comment stated that tmux cannot prove a delivery. `201-backend-neutral-pane-input` made
that false: the
guarded seam pins a pane to one tmux server generation and answers with a named verdict.
A hunter pane that never got its prompt is a zombie the user has to spot and close.

## Investigation

Measured live against a real tmux server on a throwaway socket, driving
`deliverAgentPrompt` itself rather than a mock:

| Case | Verdict |
|---|---|
| live shell pane | `delivered`, and `capture-pane` shows the command ran |
| pane killed, server alive | `not-delivered` / `pane-absent` — `no pane %1 on this tmux server` |
| pane id that never existed | `not-delivered` / `pane-absent` |
| whole server killed | `not-delivered` / `backend-failure` — `listing panes failed … no server running` |

"The pane is gone" and "tmux could not answer" stay distinct, so the message the user
gets names which one happened.

## Decision

Both backends now go through `deliverAgentPrompt` (`src/bun/rpc-handlers/tmux-pty.ts`,
`deliverHunterPrompt` + the delivery loop in `spawnBugHuntersInTask`) and act on the
`AgentPromptDelivery` vocabulary from seq 1421 — no second vocabulary. Only a proven
`not-delivered` undoes the launch; `unconfirmed` keeps the pane and logs. Rollback is
now backend-neutral (`rollBackHunterLaunch`), and a rolled-back tmux pane is retired
from `sessionState` by hand, because `kill-pane` fires no `pane-exited` hook. The false
comment went with the behaviour, in this commit, not before it.

Two deliberate divergences from the native arm as it stood, rather than quiet ones:

1. A **throw** from delivery no longer rolls back. It carries no verdict, so killing the
   pane would collapse "cannot say" into failure — the exact move
   `201-backend-neutral-pane-input` exists to prevent. It is reported as `unconfirmed`.
2. The native arm's check was `if (!(await sendPromptToNativePane(...)))`. Seq 1421
   (`4232a0211`) widened that function's return from a boolean to an `AgentPromptDelivery`
   object, and every return path is a non-null object, so the test became always-false.
   The caller was never touched; only the callee's type moved. Scope, precisely: the
   `catch` arm and the split / layout failures earlier in the function still rolled back —
   what died is the delivery **verdict** path, which is the realistic one, because
   `sendPromptToNativePane` was written to turn every provable failure into a returned
   `not-delivered` rather than a throw. Neither safety net could see it: `!someObject` is
   legal TypeScript, and the suite's negative case drove the mock with
   `mockResolvedValueOnce(false)` — a value the real function can no longer produce, so
   it was green because it asserted a path production could not reach. One broken call
   site in `src/`; every other consumer discriminates on `.status`. Routing through the
   seam restores it, and the mocks now return real delivery objects.

## Risks

The tmux launch now awaits the prompt (~5 s boot plus ~0.8 s per hunter) instead of
returning immediately, so the Find bugs action takes that long before the dialog closes —
native already behaved this way. Where the whole tmux server is gone the rollback cannot
close anything, so the error names the panes as "still open" even though the server took
them with it; the headline still reports the real failure. The seam routes on
`task.tmuxSocket`, while the surrounding launch uses `pty.getSessionSocket`; these agree
in production, and `201-backend-neutral-pane-input` makes the task the authority.

## Alternatives considered

Keeping tmux fire-and-forget and reporting the zombie panes afterwards (nothing reads
that report — the user does). Rolling back on `unconfirmed` too (kills panes that may
already be hunting). Rolling back only the pane that failed (the user asked for N hunters;
a silently smaller set is the outcome the native arm already refuses to produce).
