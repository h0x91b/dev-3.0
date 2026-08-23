# Hold the whole agent message, not just its Enter

## Context

[`hold-the-enter-behind-dev3-message`](../21/hold-the-enter-behind-dev3-message.md) held the Enter of a
`dev3 message` and typed its TEXT the moment it arrived;
[`retune-agent-message-coalescing-window`](retune-agent-message-coalescing-window.md) retuned that window to
15s idle / 60s ceiling. Mark Kestenbaum then reported [#1495](https://github.com/h0x91b/dev-3.0/issues/1495):
while he was typing instructions to one task, a peer task's message was typed into the same input box and his
text came out mixed with it. The held Enter protected him from a premature SUBMIT and did nothing at all about
interleaved TEXT — the text was never held.

## Decision

Hold the whole message. `src/bun/agent-message-hold.ts` (the rewritten coalescer) now stores, per pane, the
list of undelivered messages plus one submit closure; nothing is written to the pane until the hold releases.
`holdMessageForAgentPane` / `holdMessageForPane` (`src/bun/agent-prompt.ts`) and `performNativeDelivery`
(`src/bun/agent-prompt-native.ts`) register a hold instead of typing, and `deliverAgentPrompt`'s `hold` option
replaces `coalesceSubmit`. Three rules on top of the old timing:

- **Human-driven holds have no ceiling.** `deferHeldAgentMessagesForTask` marks the hold `humanHeld`, and the
  delay is then the full idle window with no deadline behind it. A message-driven hold keeps the 60s ceiling,
  so a stream of senders still cannot hold a receiver hostage. Arseny's ruling, verbatim: *"если оно
  откладывается, потому что я пишу, то есть человек пишет, то потолка не должно быть никакого"*.
- **The user's own plain Enter releases everything at once**, so he watches the message arrive instead of
  wondering where it went. `scanHumanTerminalInput` (`src/shared/human-terminal-input.ts`) reads the raw client
  bytes: CR outside a bracketed paste is a submit, ESC+CR (dev3's Shift+Enter, see
  [`shift-key-workaround-ghostty-web`](../../03/04/shift-key-workaround-ghostty-web.md)) is not, and neither is
  a CR inside a paste. `noteHumanTerminalInput` in `src/bun/pty-server.ts` calls it on both keystroke paths,
  after `shell.write`, so his Enter reaches the agent first.
- **A held message that never lands is lost**, and nothing is left in the input box either. Explicitly accepted
  by Arseny — *"ситуация, что приложение умерло внутри окна … это да, это утеря"* — so there is no persistence
  layer here. The old behaviour left the text visible in the box; that property is deliberately gone.

A fourth delivery answer, `held`, carries this to the caller: nothing was typed, do not re-send. The CLI says
"Message queued", both agent-skill texts say the whole message waits, and every number stays derived from
`AGENT_MESSAGE_HOLD_IDLE_MS`.

## Risks

- **A pause mid-line still lets a message land.** The release is quiet, not intent: 15s without a keystroke and
  the message goes in behind whatever half-written line is there. Raised with Arseny as an open question
  (should the human-idle window be longer than the message one?) rather than decided here.
- **A hold outlives no crash.** Anything held when the app dies is gone, with no trace for the user. Accepted
  above; a separate strand (Seq 1650) is looking at a durable message log.
- **Typing in a terminal dev3 does not serve** (an external `tmux attach`) is invisible to
  `noteHumanTerminalInput`, so such keystrokes defer nothing — as before this change.
- **`resolveAgentPromptTargetPane` runs at hold time**, so a pane that dies inside the window fails the pin at
  release and only logs it; the sender already got `held`.
- **Cross-version forwarding** keeps working because the native wire field is read as `hold`; an older process
  forwarding `coalesceSubmit` gets that version's instant submit instead of a hold.

## Alternatives considered

- **Keep typing the text, hold only the Enter (status quo).** This is exactly the reported bug.
- **A decoupled input box in the UI**, so agent traffic never shares the terminal's line editor. Arseny's own
  larger idea, and the right long-term answer; this change is the cheap mitigation, not that.
- **Concatenate held texts into one paste.** Rejected: a newline inside a text step can read as a submit to the
  agent's input layer, and one merged paste would blow the seam's 5 000-byte per-stage budget that each message
  passes on its own.
- **A hold ceiling for the human too** (a minute, say). Rejected by the ruling above; a deadline that fires
  while he is typing is the very defect being fixed.
