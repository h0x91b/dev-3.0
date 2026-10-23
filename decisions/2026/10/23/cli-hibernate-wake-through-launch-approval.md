# CLI hibernate and wake go through the launch-approval dialog

## Context

Hibernation was a button only (h0x91b/dev-3.0#2015). A coordinator knows which of its children sit idle waiting on a human merge, but could not free their memory; killing tmux by hand left the board wrong (card not greyed, ports held). The issue proposed `dev3 task hibernate` and `dev3 task wake --resume|--shell`, with approval only for cross-task hibernation.

## Investigation

The wake screen's "Wake with a plain shell" called `restartTask`, which launches the agent from scratch with the task description and clears `sessionState` — not a plain shell at all. `dev3 agent resume` already woke a hibernated task, behind the launch-approval dialog when another task's agent asked.

## Decision

- `src/bun/cli-task-session.ts` owns both commands. Any request carrying `sourceTaskId` (an agent, own task included — the user asked for it) is approved in the same `agentLaunchRequested` dialog as a launch or resume, so the queue, replay-on-reconnect, auto-approve countdown and hold-on-touch all come for free. The request is a `launch`-kind agent request carrying `AgentLaunchRequest.sessionAction`, so a hibernate and a resume can never both be pending on one task. A person outside any worktree acts directly.
- `wake --resume` is `resumeCliAgent` after a "must be hibernated" check; output and exit codes are shared with `dev3 agent resume` (`reportResumeOutcome`).
- `wakeTaskShell` (`rpc-handlers/tmux-pty/resume.ts`) is a real plain shell: `launchTaskPty` with `shellNotice` (renamed from `agentRefusal`), no agent, `sessionState` untouched so every pane stays resumable. The UI's plain-shell button now calls it too, so CLI and UI agree.
- New exit codes 35 (nothing to free), 36 (hibernate declined), 37 (not hibernated). A declined wake exits 10, like a declined resume.

## Risks

- The approval auto-approves after the launch delay. Hibernation is reversible (worktree and transcripts survive), only scrollback is lost, so an unattended approval is acceptable — the same trade the launch dialog already makes.
- An agent hibernating its own task never receives the response: the session it runs in is torn down. The CLI warns before asking.
- A plain-shell wake leaves stale pane ids in `sessionState`; a later resume relaunches by conversation id, not pane id.

## Alternatives considered

- **A new `hibernate` agent-request kind with its own `confirm()` dialog.** Rejected: `confirm()` has no countdown, and a second kind would let a hibernate and a resume race on one task.
- **Keeping the UI button on `restartTask` and mapping `--shell` to it.** Rejected: the flag would re-run the brief and drop extra panes while claiming to open a shell.
