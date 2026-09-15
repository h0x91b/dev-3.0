# Preserve Codex question waits across tool activity

## Context

Codex question cards could remain unanswered after a turn while dev3 showed Your Review. The generated tool matcher excluded both question tools, and the CLI discarded their identity; ordinary tool activity also cleared a manually selected Has Questions status.

## Investigation

In local Codex source commit `02a8f038b8` (installed CLI reports 0.154.0), `CoreToolRuntime::pre_tool_use_payload` and `post_tool_use_payload` cover function tools, including `request_user_input` and `request_user_input_async`. The former waits for a response; the latter returns immediately after emitting asynchronous question messages. PostToolUse runs only on successful tool results, and asynchronous answers return as new user messages rather than a second tool result.

## Decision

Extend `buildCodexHooks` to match both tools and forward only `tool_name` and `tool_use_id` through `handleCodexHook`. `CodexQuestionState` tracks blocking calls from PreToolUse to matching PostToolUse, and successfully queued async questions from PostToolUse until their answers or a new ordinary prompt. The CLI fingerprints the TUI `AnsweredQuestion` framing (a 512-byte UTF-8 title prefix, newlines flattened) so one answer consumes only one card; no question text is retained in the registry. `task.agentHook` preserves Has Questions through unrelated activity and async Stop, restores the previous working/review lane after resolution, and keeps panes from clearing each other's questions. Hook handling is serialized per task; Interrupt clears blocking waits and SessionEnd clears the exiting session.

## Risks

Codex exposes no dedicated hook for dismissing an asynchronous question card; the next ordinary prompt is the clearing boundary after a skipped card. Answer matching relies on the TUI framing and cannot distinguish a manually typed identical quote. The pending registry is process-local, like approval resume state: restarting dev3 loses it, and a session must restart to load changed hook matchers. Failed blocking tools have no PostToolUse, so Interrupt, Stop, session exit, or the next prompt clears their wait. Hard-killed sessions cannot emit SessionEnd.

## Alternatives considered

Mapping every question PreToolUse to PermissionRequest would incorrectly clear async questions at PostToolUse and ordinary activity. Parsing terminal text or scanning private transcripts would be brittle and unnecessary for the supported hooks. Adding a new Codex hook upstream could make dismissal exact, but cannot fix already installed clients.

## Runtime verification

The first manual retry reused Codex PID 4696, started at 13:39:38, although dev3 rewrote hook files at 14:27:05. Restarting the desktop app preserved that terminal and its old hook snapshot; before the primary app exited, CLI discovery also still selected the older primary backend. Updating the global CLI link alone cannot refresh a running Codex process.

A fresh installed Codex 0.154.0 process was then driven by a loopback-only scripted Responses endpoint, using an isolated CODEX_HOME and a fake CLI socket. With the local built CLI pinned explicitly, it delivered SessionStart, UserPromptSubmit, PreToolUse(request_user_input_async), PostToolUse with question fingerprints, Stop, and SessionEnd. Codex caps Interrupt/SessionEnd hooks at three seconds, so those generated timeouts now respect the cap; local lifecycle logs record event, pending state, and before/target/actual status without question text.

Desktop acceptance passed on 2026-09-15 with a fresh Codex session and the local dev3 backend: PostToolUse(request_user_input_async) set Has Questions, and the subsequent Stop kept it with pendingQuestions=true. The user confirmed the result in the board UI.
