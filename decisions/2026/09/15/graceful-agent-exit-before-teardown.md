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

Verified against a real Claude Code (2.1.273) in a real tmux pane, idle and mid-tool-call
(`/tmp` script, not in the repo — needs a local `claude` and model access):

- A bare `kill-session` **does** start `SessionEnd` on this build (reason `other`), idle
  or busy. The premise "SIGHUP skips the hook" is false for current Claude Code.
- What loses the hook is what dev3 runs **right after** the kill. `destroySession` is
  fire-and-forget, so `killDevServer`, the cleanup script, diff capture and
  `reapWorktreeProcesses` follow within a second; the reaper SIGTERM → SIGKILLs every
  process whose cwd is inside the worktree — the hook is one of them (its cwd is the
  worktree), and `removeWorktree` then deletes anything it read from there. A hook that
  needs 2 s wrote nothing under kill + reap; the same hook completed under the graceful
  exit, because the exit step waits for Claude's tree to empty and Claude waits for its
  hooks (1.5 s total by default, raised to the largest declared per-hook `timeout`, max 60 s).
- Typing `/exit` ends the session with reason `prompt_input_exit`, busy or idle, once a
  Ctrl-C has interrupted the running turn.

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

- **Keep the kill, just wait before reaping.** Rejected: the kill is fire-and-forget
  with nothing to wait on, a fixed sleep is a guess, and it leaves every other harness
  (and any Claude build that does not run hooks on SIGHUP) on the signal path. Asking
  the CLI to quit gives one observable — the agent's tree emptying — that already
  includes its hooks.
- **Answering the CLI before teardown so the agent is idle when asked.** Rejected for
  now: it changes the `task move` contract (the CLI would print success before the task
  is gone), and Ctrl-C first makes the request robust to both the busy and the idle case.
- **Waiting on `pane_dead` / session exit.** Rejected: the pane survives the agent by
  design (`keepShell`), so it would always time out.
