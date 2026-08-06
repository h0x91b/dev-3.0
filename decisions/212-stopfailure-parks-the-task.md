# 212 — StopFailure parks the task in Has Questions

## Context

A Claude session that hits its subscription usage limit mid-task prints
`You've hit your session limit · resets 3:40pm (Asia/Jerusalem)`, drops the turn,
and returns to its prompt. The board kept showing **Agent is Working** — for
hours, until the user happened to look into the pane. Same for an expired login
or a billing block: the agent is idle and needs a human, and nothing said so.

## Investigation

The cause is not a missing pattern match, it is a missing event. Claude Code's
`StopFailure` fires **instead of** `Stop` when an API error ends the turn, and
dev3 only listened to `Stop`. Verified against the shipped
`@anthropic-ai/claude-code` 2.1.112 bundle:

- Hook registry contains `StopFailure`; its own description reads *"Fires instead
  of Stop when an API error (rate limit, auth failure, etc.) ended the turn.
  Fire-and-forget — hook output and exit codes are ignored."*
- Payload schema: `hook_event_name`, `error`, optional `error_details`, optional
  `last_assistant_message`. The matcher matches on `error`.
- `error` enum: `authentication_failed`, `billing_error`, `rate_limit`,
  `invalid_request`, `server_error`, `unknown`, `max_output_tokens`. The HTTP 429
  path — which is where the subscription-limit sentence is produced — sets
  `rate_limit`.
- No reset timestamp anywhere in the payload. It exists only as text inside the
  limit sentence, which arrives as `last_assistant_message`.

The published hooks docs describe the payload as `stop_reason` / `error_message`
instead. The two disagree, so the parser accepts both spellings.

## Decision

`buildClaudeHooks` (`src/shared/agent-hooks.ts`) registers `StopFailure` with
**no matcher** — every one of those errors leaves the agent idle — pointing at a
new internal adapter `dev3 hook claude-stop-failure`
(`src/cli/commands/claude-stop-failure.ts`). It forwards to the
`task.claudeStopFailure` socket handler (`src/bun/cli-socket-server.ts`), which
moves the task to `user-questions`, raises the attention badge, and posts a
desktop notification. The badge reason comes from
`describeClaudeStopFailure` (`src/shared/agent-stop-failure.ts`): Claude's own
limit sentence when the last message is one (it carries the reset time),
otherwise a short per-error line.

An adapter rather than another `dev3 task move` hook, because the badge and the
notification need the error and the reset text, which a status move cannot carry.

## Risks

- **Wording drift.** The reset time is scraped from Claude's sentence via a
  prefix list (`You've hit your`, `You've used`, …). If Anthropic rewords it, the
  task still parks correctly and the badge falls back to our generic line — the
  failure mode is a vaguer reason, never a missed event.
- **Older Claude Code.** A build without `StopFailure` sees an unknown key in
  `hooks`. Nothing else in the file is affected, and the behaviour is exactly
  today's: the task keeps sitting in Agent is Working.
- **Codex is not covered.** No equivalent hook exists; a Codex quota exhaustion
  is still only visible in the rate-limit indicator.

## Alternatives considered

- **Scan the pane output for the limit sentence.** Works for Claude and Codex
  alike, but it is a regex over a live PTY stream, breaks on rewording, and can
  fire on the agent merely *quoting* the sentence. Rejected while a real event
  exists.
- **Trigger off the rate-limit monitor at 100%.** Data is already there
  (`rate-limit-monitor.ts`), but it is per *account*, not per task: with several
  tasks on one account it cannot tell which one actually died, and its 30 s poll
  is blind to auth and billing failures entirely.
- **A `matcher` limited to `rate_limit|billing_error`.** Would leave a task whose
  turn died on `authentication_failed` stuck in Agent is Working — the exact bug
  being fixed, one error value over.
