# Ask the agent to quit before killing its terminal, bounded by a process-tree poll

## Context

Every terminal teardown — task completion, cancellation, hibernation, deletion, a
resumed interrupted teardown — went straight to `destroyTaskPty`: `tmux kill-session`
(SIGHUP to each pane's foreground process) or the native host's SIGHUP → SIGKILL
ladder. The agent CLI never got a turn on its way out, so Claude Code's `SessionEnd`
hooks never ran for a task that ended the normal dev3 way; only a manual `/exit` ran
them. A project that exports a task's notes into an external knowledge base from that
hook silently lost every dev3-completed task (observed 2026-09-15).

## Investigation

Claude Code's documented `SessionEnd` reasons are `clear`, `resume`, `logout`,
`prompt_input_exit` and `other`; the observed behaviour is that a SIGHUP from
`kill-session` does not reach the hook, while a typed `/exit` does. The hook budget is
1.5 s total by default, raised to the largest declared per-hook `timeout` up to 60 s,
so a 30 s wait on our side covers any hook a user can declare short of the maximum.

Two facts shaped the mechanism. First, the agent is usually **mid-turn** when teardown
starts: the CLI-socket handler for `task.requestCompletion` awaits `moveTask` before
answering the `dev3 task move` process, so the agent's Bash tool is still blocked while
we type — and a CLI mid-turn queues typed text rather than running it. Ctrl-C first
interrupts that turn (on an idle prompt it only prints a "press again" hint), and only
then does the slash command run. Second, the pane does **not** die when the agent
exits: `buildCmdScript` hands the pane over to an interactive shell (`keepShell`), so
"the agent is gone" is "the pane root has no descendants", read from one `ps` snapshot
(`collectProcessInfo`), not `pane_dead`.

## Decision

- `AgentAdapter.exitProgram()` (`src/shared/agent-adapters/types.ts`) is the per-CLI
  descriptor: `slashExitProgram("/exit" | "/quit")` in `common.ts` yields Ctrl-C, a
  500 ms gap, the command, an 800 ms gap, Enter — inside the pane-input seam's 2 s
  in-band delay budget. Claude, Cursor, Copilot and OpenCode use `/exit`; Codex and
  Gemini `/quit`; the generic adapter returns null and teardown goes straight to the kill.
- `src/bun/agent-graceful-exit.ts` — `requestGracefulAgentExit(task)` resolves live
  agent panes from `task.sessionState.panes` (tmux: joined with `list-panes` pane pids;
  native: `pane-1` and its shell pid), skips panes whose tree is already empty, types the
  program through `sendPaneInput`, then polls every 250 ms up to 30 s. It never throws.
  When `ps` is unavailable it waits one blind 5 s grace instead of polling.
- A new `gracefulAgentExit` lifecycle effect (`onError: "continue"`) is emitted
  immediately before every `destroyTaskPty` in `src/bun/lifecycle/machine.ts`; the
  executor case awaits the request. Machine and native-teardown tests pin the ordering.

## Risks

- Ctrl-C reaches a tool the agent is running; for the completion flow that tool is the
  `dev3 task move` that was already approved, so nothing is lost, but an agent mid-way
  through an unrelated command at cancellation time is interrupted rather than killed —
  the same end state, one step earlier.
- The 30 s bound is now the worst-case added latency of a teardown when an agent
  ignores the request. The step is logged at `warn` when it times out.
- A CLI whose quit command changes goes back to the kill path silently; the matrix row
  in `agent-support-matrix.md` is where the command is documented.

## Alternatives considered

- **Signal-only (SIGTERM before SIGHUP).** Rejected: the evidence is that signals do
  not run the hook, and the dev3 status hooks already declare `SessionEnd` with a 3 s
  timeout that never fired on kill.
- **Answering the CLI before teardown so the agent is idle when asked.** Rejected for
  now: it changes the `task move` contract (the CLI would print success before the task
  is gone), and Ctrl-C first makes the request robust to both the busy and the idle case.
- **Waiting on `pane_dead` / session exit.** Rejected: the pane survives the agent by
  design (`keepShell`), so it would always time out.
