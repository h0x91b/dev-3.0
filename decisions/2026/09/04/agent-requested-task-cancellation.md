# Agent-requested task cancellation

## Context

Agents over-create tasks. Until now an agent could not clean up after itself: the
CLI exposed `show/create/update/move`, `completed` needed the user's approval, and
`cancelled` was refused outright ("use the desktop app UI"). Every wrong card an
agent made became manual one-at-a-time work for the user.

An agent vent (2026-06-25) asked for `dev3 task delete <id>` behind an approval
dialog, plus batch deletion by id list or label filter.

## Decision

Not delete — **cancel**. `dev3 task move --status cancelled` now mirrors the
completion flow exactly: the CLI sends `task.requestCancellation`, blocks up to
10 minutes, and the app asks the user. Nothing is deleted; the task moves to
`cancelled`, which the board already understands and which keeps the card, its
notes and its history.

- CLI: `requestCancellation` in `src/cli/commands/task.ts`, exit `22`
  (`CLI_EXIT_CODE_CANCELLATION_DECLINED`) when declined — deliberately not
  reusing exit `6`, because "the work landed" and "the work is garbage" must be
  distinguishable by the agent reading the code.
- Backend: `task.requestCancellation` in `src/bun/cli-socket-server.ts`, request
  kind `"cancel"` in `src/bun/agent-requests.ts`, replay handlers in
  `src/bun/rpc-handlers/task-lifecycle.ts`. **No `autoApproveAfterMs`** — the
  launch dialog auto-approves on a timer, this one never can.
- Renderer: its own push (`agentCancellationRequested`) and its own effect in
  `App.tsx`. The dialog is `tone: "danger"` — a new `confirm()` option that
  paints the frame, the agent badge and the subject card red, not just the
  button — with Cancel autofocused, and it streams `getUnsavedWork` into the
  gated `deferred` block so the confirm button is unavailable until the dialog
  can say what would be lost.

Batch cancellation was dropped from scope on the user's instruction: one task,
one dialog.

## Risks

An agent can now end its own session without the user typing anything, if the
user clicks through the dialog. Mitigated by the danger chrome, the autofocused
Cancel, and the git gate — but a user who approves everything can lose a
worktree. The `cancelled` status itself is not new, and the same warnings already
guard the UI paths.

## Alternatives considered

- **`dev3 task delete` as asked.** Rejected: deleting drops the card, its notes
  and its history, and dev3 has no delete path an agent could ask for. `cancelled`
  already means "this should not have existed" and is reversible on the board.
- **Reuse `agentCompletionRequested` with a flag.** Rejected: one channel means
  one pending-request kind, and an approval meant for a completion dialog could
  then destroy a worktree through the other. Separate kind, separate push.
- **Same exit code as a declined completion.** Rejected: an agent retrying the
  wrong one of the two is exactly the mistake a distinct code prevents.
