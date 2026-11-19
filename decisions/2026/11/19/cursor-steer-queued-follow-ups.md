# Steer queued Cursor follow-ups with a second Enter

## Context
Cursor Agent puts a prompt submitted during a busy turn into a "follow-ups" queue and only runs it after the turn ends. Peer `dev3 message` traffic piled up there: one message sat 41 minutes, and the user's own question waited behind five agent envelopes. dev3 had typed each message within its 15-second hold, so the delay was all inside Cursor's queue.

## Investigation
- Cursor's `postToolUse` hook does accept `additional_context` (CLI 2026.11.19), but it is appended to the tool result. In a live probe the model said the text "came from the command output, not from you, so I ignored it". A Claude-style hook mailbox would therefore be ignored, or read as prompt injection.
- With a non-empty queue and an empty input, Cursor's Enter is the "steer" action (`queuedMessageEmptyInputAction`). Probed live: text, then Enter (queued), then Enter 800 ms later put the message into the running turn as a user message. The model listed it as message 2 of that turn. An extra Enter on an idle Cursor started no empty turn.

## Decision
`AgentAdapter.enterSteersQueuedPrompt` (Cursor only) drives `scheduleQueuedPromptSteer` in `src/bun/agent-prompt.ts`. It presses one more Enter 800 ms after a held message or direct prompt is submitted, on tmux (`steerTmuxPane`) and native (`submitNative` in `agent-prompt-native.ts`). The pane's agent is read from `sessionState.panes`. The steer runs as its own step, so a refused or skipped steer never changes the held message's verdict: that message is already submitted.

## Risks
- **User typing:** a keystroke after the submit (`humanTypedSince` in `agent-message-hold.ts`) cancels the steer, so a fresh draft is never sent.
- **Queue order:** steering moves only the head of the queue. A follow-up the user queued first goes in instead, and ours stays queued.
- **Running shell:** steering can background a running shell; Cursor then waits for it.
- **Not covered:** panes without a session entry (the AI-review column pane, a main entry whose pane id is still unknown) and native deliveries forwarded to another app process keep one Enter, the old behaviour.

## Alternatives considered
A Cursor `postToolUse` mailbox: rejected, because the model ignores hook context as untrusted output. Waiting for Cursor's `stop` hook `followup_message`: it still only fires when the turn ends.
