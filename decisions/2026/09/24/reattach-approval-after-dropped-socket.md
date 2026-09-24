# Re-attach a completion/cancellation approval after a dropped socket

## Context
`dev3 task move --status completed|cancelled` blocks up to ten minutes on one socket. When that socket closed early ("Empty response from server"), the CLI exited 1 even though the request lives in the app's memory (`src/bun/agent-requests.ts`) and was usually still pending with its dialog on screen. The agent could not tell pending from answered from lost, and a blind retry risked asking the user twice. A vent from 2026-08-22 also blamed status hooks; they are unrelated — there is no "approval pending" task status, and `task show` reads the same state as the board.

## Decision
- The registry remembers each request's answer for `AGENT_REQUEST_OUTCOME_TTL_MS` (`getAgentRequestState`), and `joinAgentRequest` joins a live request without ever creating one.
- `task.requestCompletion` / `task.requestCancellation` accept `attachOnly`: join, or report `{ attached: false, status }`. A read-only `approval.status` socket method returns `pending | answered | none` plus the task's live status (`src/shared/agent-approval.ts`).
- The CLI (`waitForDestructiveApproval` in `src/cli/commands/task.ts`) treats a closed/reset connection as "state unknown", probes `approval.status` on the SAME socket for up to a minute, and re-attaches only after the app confirmed the request is pending. The probe goes first so an older app, which would read `attachOnly` as a fresh request, is never sent one. The ten-minute deadline is unchanged and not extended by a re-attach.
- New exit codes: 25 still pending (timeout, dialog still open), 26 outcome unknown. `none` is never reported as a decline or as "nothing was approved"; only the task's live status says whether the move happened.

## Risks
- The outcome memory is in-process: after an app restart every answer reads as `none`, so the CLI can only report the task's status. That is deliberate — no claim beyond the evidence.
- The CLI does not fail over to another instance's socket (a restart changes `<pid>.sock`), so after a restart it usually reports "could not be reached" (26). Failing over could ask a different instance about a request it never held.
- The launch approval (`task.move` to an active status) is not covered; it has its own auto-approve timer and deserves its own pass.

## Alternatives considered
- Plain retry of the same request on an empty response: joins when pending, but silently opens a NEW dialog when the app restarted — a second ask the agent never made.
- Status-only probe without `attachOnly`: racy — the user can answer between probe and retry, and the retry then creates a new dialog.
- Making hooks skip status changes while an approval is pending: fixes nothing, the disagreement was never in task status.
