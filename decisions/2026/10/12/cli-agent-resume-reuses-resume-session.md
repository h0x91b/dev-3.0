# `dev3 agent resume` reuses the Resume Session path, with CLI-only guards

## Context

After a machine restart a task keeps its worktree, branch and saved conversations but has no terminal (h0x91b/dev-3.0#1887). The app's **Resume Session** button recovers it; the CLI had nothing. `agent spawn` needs a live terminal, `task move --status in-progress` on an active task is a plain board move (`prepareTask` only runs on activation), and `task open` only navigates.

## Investigation

`resumeTask` (`src/bun/rpc-handlers/tmux-pty.ts`) destroys any in-memory session before relaunching, so calling it on a live terminal tears the agent down. With no saved id a pane resumes the harness's own latest (`--continue`-style), which can start a new conversation without saying so. On the native backend only the main pane is relaunched; extra panes stay saved but are not reopened.

## Decision

`resumeTask` became `resumeTaskSession(taskId, opts)`, which returns a per-pane report (the id passed to the harness and how it was chosen: `exact`, `substituted`, `unverified`, `agent-latest`). The button still calls it with no options, so its behaviour is unchanged. `dev3 agent resume` (`src/bun/cli-agent-resume.ts`) adds `refuseLive` (exit 31, touches nothing), `refuseFresh` (exit 32 always: a harness whose adapter has `supportsResume: false` would silently restart from the task description, judged from the pane's agent record exactly as the relaunch resolves it) and `requireSessionIds` (exit 32 unless `--allow-agent-latest`). `agent spawn` now checks the backend session before its approval dialog: an active card whose terminal died used to be approved and then fail on `split-window`. One in-flight resume per task is shared by the button and the CLI, so a click during a CLI resume joins it instead of killing it. A request from another task's agent goes through the existing launch-approval dialog in a `resume` mode that shows the saved panes and offers no agent choice; the dialog's pick is ignored. A `taskTerminalResumed` push makes a recovery screen still on display re-read instead of offering Resume again.

## Risks

The native backend still restores only the main pane; the CLI reports the others as `skipped` rather than fixing that. Codex conversation claims are written before the `requireSessionIds` check can refuse, which is harmless because a later resume would choose the same ids. A requester-initiated resume needs a connected app window, and inherits the launch auto-approval timer.

## Alternatives considered

Documenting `task move` as the CLI route was rejected: it does not touch the terminal. A separate confirm-style approval kind was rejected because the launch dialog already has queueing, auto-approve, hold and stale voiding. Guarding live terminals inside the button's path too was rejected for this change: the button only shows when the backend session is gone, and the single-flight and the push cover the CLI race.
