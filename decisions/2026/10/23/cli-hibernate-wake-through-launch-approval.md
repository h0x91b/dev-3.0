# CLI hibernate and wake go through the launch-approval dialog

## Context

Hibernation was a button only (h0x91b/dev-3.0#2015). A coordinator knows which of its children sit idle waiting on a human merge, but could not free their memory; killing tmux by hand left the board wrong (card not greyed, ports held). The issue proposed `dev3 task hibernate` and `dev3 task wake --resume|--shell`, with approval only for cross-task hibernation.

## Investigation

The wake screen's "Wake with a plain shell" called `restartTask`, which launches the agent from scratch with the task description and clears `sessionState` — not a plain shell at all. `dev3 agent resume` already woke a hibernated task, behind the launch-approval dialog when another task's agent asked.

## Decision

- `src/bun/cli-task-session.ts` owns both commands. Any request carrying `sourceTaskId` (an agent, own task included — the user asked for it) is approved in the same `agentLaunchRequested` dialog as a launch or resume, so the queue, replay-on-reconnect, auto-approve countdown and hold-on-touch all come for free. The request is a `launch`-kind agent request carrying `AgentLaunchRequest.sessionAction`, so a hibernate and a resume can never both be pending on one task. A person outside any worktree acts directly.
- The approval plumbing itself — the one-request-per-task dialog, the run-identity re-check after approval, and the join-a-retry map — lives in `src/bun/cli-session-approval.ts` (`askSessionApproval`, `sameRunAfterApproval`, `perTaskJoiner`), shared with `cli-agent-resume.ts` so the two cannot drift. Resolving the requesting task from `sourceTaskId` is `resolveRequesterTask` in `cli-socket/task-resolution.ts`, shared with `agent.spawn` and `agent.resume`.
- `wake --resume` is `resumeCliAgent` after a "must be hibernated" check; output and exit codes are shared with `dev3 agent resume` (`reportResumeOutcome`).
- `wakeTaskShell` (`rpc-handlers/tmux-pty/resume.ts`) is a real plain shell: `launchTaskPty` with `shellNotice` (renamed from `agentRefusal`), no agent, and every saved pane **parked** (`paneId: null`, `parked: true` on `PaneSessionEntry`) so it stays resumable. `handlePaneExited` never adopts or drops a parked entry; a resume clears the flag. No agent runs, so `ensureAgentTrust` is skipped too. The UI's plain-shell button now calls it too, so CLI and UI agree.
- New exit codes 35 (nothing to free), 36 (hibernate declined), 37 (not hibernated). A declined wake exits 10, like a declined resume.

## Risks

- The approval auto-approves after the launch delay. Hibernation is reversible (worktree and transcripts survive), only scrollback is lost, so an unattended approval is acceptable — the same trade the launch dialog already makes.
- An agent hibernating its own task never receives the response: the session it runs in is torn down. The CLI warns before asking.
- Without parking, the saved panes kept the dead session's pane ids, and the first split that exited in the woken shell made the reconciler drop every saved conversation (reproduced in review: 2 entries → 0). Older app versions do not know `parked` and still reconcile such a task the old way.
- The approval's pending check and its request creation run in one tick (`askSessionApproval`): across an `await`, a second request would pass the check and join the first one's decision, so one approval would act twice.
- Both commands take a positional id, so a valueless flag that swallows it (`--json seq:12`, `--resume seq:12`) would silently fall back to the worktree's own task. `rejectFlagValues` in `src/cli/commands/task.ts` refuses a value on `--json`/`--resume`/`--shell`/`--allow-agent-latest` instead.

## Alternatives considered

- **A new `hibernate` agent-request kind with its own `confirm()` dialog.** Rejected: `confirm()` has no countdown, and a second kind would let a hibernate and a resume race on one task.
- **Keeping the UI button on `restartTask` and mapping `--shell` to it.** Rejected: the flag would re-run the brief and drop extra panes while claiming to open a shell.
