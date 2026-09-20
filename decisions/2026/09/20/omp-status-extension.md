# omp status through a generated extension

## Context

`decisions/2026/09/12/omp-first-class-agent.md` landed omp with manual status: the agent had to run
`dev3 task move` itself, as Gemini and Cursor do. Automatic status was deferred because omp has no
Claude/Codex-style JSON hooks — only in-process TypeScript extension modules — and shipping one means
maintaining code against a plugin API that moves weekly. This record is that decision.

## Investigation

Checked against omp/18.1.19 and again against 18.2.6 with a probe extension, not only its docs: `session_start`, `input`,
`agent_start`, `tool_call`, `tool_execution_start/end`, `turn_start/end`, `session_stop`, `agent_end`
and `session_shutdown` all fire, in that order; `ctx.sessionManager.getSessionId()` answers from
`session_start` on with the id `--resume` takes; a `--hook` process inherits `$TMUX_PANE` and the
pane's environment; `input` fires only in interactive mode, which is how dev3 runs omp. Extensions
run in the agent's process with no isolation, and an unhandled throw in a raw timer or a detached
promise tears the whole session down. An explicitly passed `--hook` path faces no trust prompt; the
newer `--trusted-extension` flag is an allowlist mode that excludes ambient discovery, not a gate.

## Decision

One generated module, `~/.dev3.0/data/agent-hooks/omp-status.ts`, built by `buildOmpStatusExtension`
and written by `writeOmpStatusExtension` in `src/shared/omp-status-extension.ts`, mirroring the
build/write split of the Claude and Codex hooks. `ompAdapter.hooksSpec()` returns `{ kind: "omp" }`;
`setupAgentHooks` (`src/bun/agent-hooks.ts`) writes the file and returns `--hook <path>`, which the
existing splice puts on fresh launches and resumes alike. The module translates omp's events into the
status vocabulary Codex already reports (`STATUS_HOOK_EVENTS`, renamed from its Codex-only name) and
spawns `dev3 hook omp` (`src/cli/commands/omp-hook.ts`) with a JSON payload on stdin, so the atomic
`task.agentHook` socket handler, the target-status table and per-pane session capture serve both
harnesses; the handler now carries a `harness` field for prompt recording. Choices worth recording:

- **Reports are serialized.** Handlers never await a report — omp is not slowed — but the reports
  queue one after another, because two concurrent CLI processes could deliver a tool's `PostToolUse`
  after the agent's `Stop` and strand the task in-progress. Codex avoids this by running hook
  commands sequentially itself.
- **Working events are throttled in-process.** Once the agent is known to be working, tool events are
  re-sent only every 10 s, so a long turn costs a few processes rather than one per tool call; the
  refresh keeps a card the user dragged elsewhere from staying wrong for the whole turn. A prompt,
  an approval and a stop are always sent.
- **The human's prompt gets a minted id.** omp's `input` event has no per-submission identity, and
  `recordTerminalPromptSubmission` refuses to record without one. The extension reports each input
  exactly once, so a random UUID is a sound identity. Extension-sourced inputs carry no prompt.
- **The CLI path is baked in absolute.** The module runs in omp's process with no shell to expand
  `~`, so it gets `<dev3 home>/bin/dev3` (POSIX) or the Windows CLI lookup, not the frozen POSIX
  hook spelling.
- **`DEV3_TASK_ID` guards the module** so a session that somehow loads it outside a task spawns
  nothing, the same guard Codex's declarations carry.
- **`agent_end` is the stop**, skipped when `willContinue` says omp is about to retry, and
  approval events from another session in the same process are ignored.
- **omp's completion bell is switched off** (`PI_NOTIFICATIONS=off` in `OMP_DEFAULT_ENV`,
  `src/bun/agents.ts`). omp rings a bare BEL when a turn ends (`completion.notify`, on by default),
  dev3's PTY reader turns any bare BEL into a `user-questions` move, and that move lands ~200 ms
  before the extension's `Stop` — which then sees a task already parked and refuses to touch it.
  Every finished turn ended in Has Questions on the first end-to-end run. The env var is omp's own
  kill switch for terminal notifications, honoured before any per-setting check.

## Risks

**The old generic skill reaches the agent through a directory dev3 does not own.** omp also
loads `<home>/.agents/skills/` — and under WSL the *Windows* profile too — at lower precedence
than `~/.omp/agent/skills/`. A machine where another dev3 install wrote the manual-status generic
skill there (a Windows dev3 in this case) hands omp a `SKILL.md` that says "run `dev3 task move`
at the start and end of every turn", so the agent may move the task itself before the extension
reports. Harmless in practice — both agree on the destination — and the system prompt still
carries the hook-aware body; a stale skill copy is a general dev3 problem, not an omp one.


The plugin API is the risk: a renamed event or context field silently stops reports, and nothing
but the board going stale says so — the generated module deliberately guards every access and logs
through `pi.logger`, but it cannot detect an event that never fires. The runtime test executes the
generated module against a stand-in CLI, which fixes the mapping and ordering but not omp's side of
the contract; a probe run against a new omp release is the check. The `harness` field defaults to
Codex when absent, because the managed CLI copy under `~/.dev3.0/bin` can predate this change.

## Alternatives considered

*Connect to the dev3 socket from inside the extension* — rejected: it would duplicate the socket
protocol in a file that ships to every machine, and one process per report is exactly the Codex cost.
*A worktree-local `.omp/hooks/pre/` module* — rejected: native discovery honours gitignore and the
file would need per-worktree writes and cleanup; one absolute path has neither problem.
*Report every tool event like Codex* — rejected: a process per tool call was measurable on Codex
boards and there is no matcher to narrow it here; in-process state is cheaper than any matcher.
