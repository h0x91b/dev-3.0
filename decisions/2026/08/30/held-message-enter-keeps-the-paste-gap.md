# The held message's Enter keeps the hand-off's paste gap

## Context

`dev3 message` sometimes landed its whole text in the receiving Claude Code pane and never
submitted it. From then on the pane stayed stuck: every later message was appended to the same
unsubmitted input box, so a stream of messages piled up and the receiving agent read none of them.

## Investigation

`AGENT_PROMPT_ENTER_DELAY_MS` (800 ms) exists precisely because Claude Code's input layer reads a
fast "text then CR" as one paste, newline included, and inserts it into the prompt box instead of
submitting. Button hand-offs (`agentPromptStages`) carry that gap as a stage delay.

Held messages did not. In
[`hold-the-enter-behind-dev3-message`](../21/hold-the-enter-behind-dev3-message.md) the text was
typed on arrival and the Enter followed ten seconds later, so no gap was needed. When
[`hold-the-agent-message-not-just-its-enter`](../23/hold-the-agent-message-not-just-its-enter.md)
moved the TEXT into the hold as well, `release()` came to call `deliver()` and then `submit()`
back to back — two `tmux send-keys` spawns apart, tens of milliseconds — which is exactly the
window the 800 ms constant was introduced to avoid. The app's own logs support this: over five
days no `held agent message submit did not land` warning was ever written, so tmux always accepted
the Enter and the receiving app swallowed it.

## Decision

The gap moves to where the Enter is produced, per backend, so the hold module keeps meaning
*when* the burst is released rather than *how* it is typed:

- tmux — `agentPromptSubmitStages()` (`src/bun/agent-prompt.ts`) carries
  `delayBeforeMs: AGENT_PROMPT_ENTER_DELAY_MS`. It fits under `PANE_INPUT_LIMITS.maxTotalDelayMs`
  (2 s) and the default 5 s deadline.
- native — the held `submit` in `performNativeDelivery` (`src/bun/agent-prompt-native.ts`) goes
  through `scheduleAgentPromptSubmit`, the same helper the hand-off path uses.

## Risks

- The user can start typing inside the extra 800 ms and his keystrokes then ride into the submitted
  burst. That race is unchanged in kind — the delivery already spans two guarded sends — and 800 ms
  after a 15 s hold is a rounding error against it.
- 800 ms is a heuristic against another program's paste detection, not a proof. A far slower box
  could still deliver the CR inside the paste window; the failure mode is unchanged and visible on
  screen.

## Alternatives considered

- **Send Enter twice.** Breaks the load-bearing "one burst, one Enter" invariant: when the first CR
  does submit, the second lands in the agent's running turn and can submit whatever the user has
  typed since.
- **Capture the pane after the Enter and re-send when the text is still sitting there.** Genuinely
  robust, but it needs pane-content parsing on tmux and has no counterpart at all on native.
- **Put the sleep in `release()`.** One place for both backends, but it makes the hold module own a
  Claude-Code paste detail and pushes the wait outside the pane-input seam's deadline accounting.
