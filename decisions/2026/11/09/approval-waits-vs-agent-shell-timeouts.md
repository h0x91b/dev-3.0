# Approval waits vs agent shell timeouts

## Context

`dev3 task move --status completed|cancelled|todo`, `--run` and `dev3 agent spawn|resume` block up to ten minutes on the user's answer. Live QA of the completion offer style (seq 54) saw opencode give up on `dev3 task move --status completed` after 120 s ("Command exceeded timeout of 120000 ms") and run it again. The retry joins the same request (`createAgentRequest` dedups by kind and task), so approving still completes the task; each retry costs an agent turn.

## Investigation

Read from each harness's release source or docs on 2026-11-09. Claude Code (Bash, 2.1.x): default 120 s, model `timeout` up to 600 s; on timeout the command moves to the background and keeps running. opencode v2.2.6 (shell): default 120 s, model `timeout` in ms with no cap (`0` disables); on timeout it kills the process. Codex rust-v0.167.0 (`exec_command`): returns after `yield_time_ms` and the process keeps running for `write_stdin` polls. Gemini CLI v0.67.0 (`run_shell_command`): no per-call timeout; it kills a command after 300 s without output (`tools.shell.inactivityTimeout`). dev3 sets no env var that names the harness.

## Decision

Two changes, each for the harness that needs it. The generic protocol family (opencode, Cursor, Gemini) gets one sentence asking for a 660000 ms shell timeout on commands that wait for the user (`SKILL_LONG_WAIT_SHELL` in `src/shared/agent-skill-content.ts`); Claude and Codex bodies skip it, which also keeps them under the command-line budget. Every ten-minute wait in the CLI prints a stderr line each minute (`withWaitHeartbeat` in `src/cli/launch-approval.ts`), which keeps Gemini's inactivity timer from firing.

## Risks

A model can ignore the sentence; opencode then kills the command at 120 s and the retry joins the same request, as before. The generic body has about 120 characters of budget left. The harness facts are pinned to the versions above and can drift.

## Alternatives considered

- Exit early with code 25 (still pending, re-run waits on the same request) before 120 s: no worse than today for opencode, but a model that passed a long timeout would still re-run about six times in ten minutes. Without a harness env var from dev3 it would need sniffing `OPENCODE` / `GEMINI_CLI`.
- The timeout sentence in every family: Claude cannot ask for more than 600 s and does not need it, and the Codex body has no room.
