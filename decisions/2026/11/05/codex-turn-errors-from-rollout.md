# Codex turn errors and approval holds, read from the rollout and the Stop message

## Context
Codex 0.163 fires no hook when an API error ends a turn — no `Stop`, and its hook schema has no `StopFailure` equivalent — so the last hook dev3 saw (`UserPromptSubmit`) leaves the card in "Agent is Working" indefinitely. Separately, a security hook that *denies* a tool until the user types `Approved <ref>` (an org security policy hook) gives Codex nothing to raise as a `PermissionRequest`; the agent relays the reply and ends its turn, so `Stop` files the card under review.

## Investigation
The rollout JSONL records every turn end as `event_msg` / `task_complete`, with an `error: { message }` object when the turn died (`turn_aborted` on interrupt). Every hook payload carries `transcript_path`, the absolute rollout path, so no `CODEX_HOME`/account resolution is needed. That hook's deny text is `Reply \`Approved <12-hex>\` to allow it`, and the agent's final message repeats that reply in every observed session.

## Decision
`SessionStart`/`UserPromptSubmit` forward `transcriptPath`; `CodexTurnWatches` (`src/bun/codex-turn-watch.ts`) polls that file from its size at the prompt and reads only appended bytes until the first turn end. An errored end runs `parkFailedTurn` in `src/bun/cli-socket/agent-commands.ts`, shared with Claude's `task.claudeStopFailure`. `Stop`/`Interrupt`/`SessionEnd` and task teardown drop the watch. The CLI matches `findApprovalHoldReply` (`src/shared/agent-stop-failure.ts`) against the Stop's `last_assistant_message` and the handler targets `user-questions` plus a badge naming the reply.

## Risks
The rollout format is undocumented; a rename of `task_complete` silently returns Codex to the old stuck behaviour (no false moves). A watch is in-memory, so an app restart mid-turn loses it until the next prompt. The watch ends on the first turn end it reads, not on a matching `turn_id` (the hook's and the rollout's ids are not proven identical); that holds because Codex fires the next `UserPromptSubmit` only after the previous `task_complete` is written. A session killed with no exit hook keeps a one-stat-per-second poll until the task ends. Failures are only acted on for interactive conversations (`isInteractiveCodexConversation`), so a subagent's error never parks its parent. The approval-hold match keys on agent wording, so a message that paraphrases the reply is missed (falls back to review, as before).

## Alternatives considered
Codex `notify` config is a single user-global slot the user may already own and fires on success, not errors. A periodic sweep over all in-progress Codex tasks costs a scan per tick for an event the watch catches within a second.
