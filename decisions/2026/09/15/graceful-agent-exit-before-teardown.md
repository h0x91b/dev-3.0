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
  native: `pane-1` and its shell pid), types the program through `sendPaneInput`, then
  polls every 250 ms up to 30 s. It never throws: the whole body is wrapped and every
  failure comes back as an outcome.
- **Two signals, deliberately not one.** Before typing, the step asks *"is the agent
  itself running under this pane?"* — `agentPidsUnder` matches the recorded `agentCmd`
  against the leading program names of each descendant's command line (argv0, plus the
  script of an interpreted CLI, parsing stopped at the first flag because an agent's
  command line carries the whole task prompt after its flags). After typing it asks the
  different question *"has the pane gone quiet?"* — the whole subtree, because the exit
  hook is a separate process that outlives the agent and waiting for it is the point.
  Using "the agent is gone" as the completion signal would have reintroduced the bug.
- **Readiness is required before a single keystroke, and it is a third signal.**
  Identity proves the CLI is running, not that it has a prompt: one still in its trust
  dialog or first-run wizard would take the program's Enter as an answer to that dialog.
  Teardown does not make that harmless — hibernation keeps the worktree, and a trust
  decision is the user's to make. `AgentPromptReadiness` is asked per PANE (`ready` /
  `not-ready` / `unknown`) and only `ready` earns keystrokes; everything else skips with
  `not-ready` and an `info` log. The proof is #1785's launch-scoped
  `agentReadiness(taskId)` (`src/bun/agent-readiness.ts`), mapped `booting`/`gone` →
  `not-ready`; deliberately not its `agentAcceptsTypedInput`, which folds `unknown` into
  true so ordinary messages are not blocked. Until that lands the default resolver
  answers `unknown`, so this step types nothing at all.
- **Absent process evidence is never read as "the agent left."** `collectProcessInfo`
  reports a missing or failed `ps` as an EMPTY table (`runText` swallows every failure
  and returns `""`), which counted as "no descendants" and therefore "already exited" —
  silently disabling the step on any platform without `ps`, Windows included, while a
  blind-wait branch written for that case could never run. `readAgentProcessEvidence`
  now returns `null` on Windows, on a throw, and on an empty table, and the step skips
  with `no-process-evidence` and an `info` log. Same rule as
  `terminal-process-ownership/collector.ts`: absent evidence is reported, not guessed.
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
- **Windows gets nothing from this step**, and says so in the log instead of pretending.
  Process enumeration there needs a different mechanism (Job Object membership proves
  identity but cannot enumerate a tree), so the native path stays exercised by unit
  tests only until that exists.
- Only Claude's `/exit` (2.1.273) and Gemini's `/quit` (gemini-cli 0.46.0, whose bundle
  registers `quit` with `exit` as an alias) have been checked against the real CLI.
  Codex, Cursor, Copilot and OpenCode ship compiled binaries and their quit commands are
  taken from documentation, not observation. A wrong one costs the 30 s bound per
  teardown for that harness and nothing else.
- **This step stays inert until the production resolver is WIRED**, which is a change in
  this file, not a merge order. `defaultAgentPromptReadiness` answers `unknown` and
  nothing outside this module can change that: merging #1785 on its own leaves the
  default in place and the step silent. Wiring it is required integration before this
  ships, and it has to be proved through the real resolver — mixed ready/unready panes,
  a stale launch generation, and a Claude quit whose `SessionEnd` descendant is still
  running — not through the test stubs the unit suite injects.
- **A harness that reports no lifecycle at all answers `unknown` forever** and therefore
  never gets a graceful exit. Today that is Gemini, Cursor and OpenCode. Stated here
  rather than discovered later: the gate is deliberately conservative, and widening it
  means giving those harnesses a receipt, never loosening the rule.
- **The seam asks per pane on purpose.** An early version of the readiness contract was
  keyed on the task alone, which cannot tell two agent panes apart — one can be mid-launch
  while the other is long past its trust prompt. The resolver here takes the pane and a
  test pins that one pane's verdict never authorizes another. The receipt side then moved
  the same way: `agentReadiness(taskId, paneId?)` keys receipts by the pane the hook
  reported from, so this step passes its pane rather than relying on the strict
  task-wide answer that omitting it gives. Its receipts also carry a launch generation
  token and expire on a receipt, a session end or the pane disappearing — never on a
  clock, because a timeout would un-gate the exact pane whose dialog is still open.
  Two things the wiring may never treat as proof, both of which hand this gate a
  `ready` belonging to something else: a task-wide answer substituted for a pane with
  no receipt of its own (an unrecognized pane is precisely the one that never reported
  being at a prompt), and a tokenless receipt unlocking a launch that carries a token
  (the stale hook from the agent just replaced, which is what the token exists to
  catch). Either one unresolved means the resolver answers `unknown` and this step
  skips.
- **Support means two conditions, not one.** A harness is covered only where both the
  quit command has been observed against the real CLI and readiness can be proved for the
  current launch. They fail independently: Gemini's `/quit` is verified but has no
  readiness receipt, while Codex and Copilot may have receipts but their quit commands
  have never been validated. `agent-support-matrix.md` states both per agent.
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
- **Typing at any pane that has something running under it.** Rejected after review:
  after the agent exits the pane belongs to a shell, so "busy" also means a job the user
  started, which would earn a Ctrl-C and a stray `/exit` plus the full 30 s bound on a
  teardown somebody is waiting for.
- **Keeping the blind wait for platforms with no process table.** Rejected: without the
  table the agent cannot be identified either, and a slash command typed at an
  unidentified pane is worse than an honest skip. A logged skip also leaves a trace when
  someone asks why Windows never runs exit hooks.
