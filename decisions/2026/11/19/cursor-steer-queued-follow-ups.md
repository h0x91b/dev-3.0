# Steer queued Cursor follow-ups with a second Enter

## Context
Cursor Agent puts a prompt submitted during a busy turn into a "follow-ups" queue and only runs it after the turn ends. Peer `dev3 message` traffic piled up there: one message sat 41 minutes, and the user's own question waited behind five agent envelopes. dev3 had typed each message within its 15-second hold, so the delay was all inside Cursor's queue.

## Investigation
- Cursor's `postToolUse` hook does accept `additional_context` (CLI 2026.11.19), but it is appended to the tool result. In a live probe the model said the text "came from the command output, not from you, so I ignored it". A Claude-style hook mailbox would therefore be ignored, or read as prompt injection.
- With a non-empty queue and an empty input, Cursor's Enter is the "steer" action (`queuedMessageEmptyInputAction`). Probed live: text, then Enter (queued), then Enter 800 ms later put the message into the running turn as a user message. The model listed it as message 2 of that turn. An extra Enter on an idle Cursor started no empty turn.

## Decision
`AgentAdapter.enterSteersQueuedPrompt` (Cursor only) makes `agentPromptSubmitStages` in `src/bun/agent-prompt.ts` send a second Enter, with the usual 800 ms gap, for held messages and direct prompts. `paneSteersQueuedPrompt` reads the pane's agent from `sessionState.panes`.

## Risks
Steering only moves the queue head, so a follow-up the user queued first goes in instead and ours stays queued. That is still an improvement. Steering can background a running shell, and Cursor then awaits it. If the user starts typing inside the 800 ms gap, the second Enter submits that partial line. The first Enter already has the same exposure.

## Alternatives considered
A Cursor `postToolUse` mailbox: rejected, because the model ignores hook context as untrusted output. Waiting for Cursor's `stop` hook `followup_message`: it still only fires when the turn ends.
