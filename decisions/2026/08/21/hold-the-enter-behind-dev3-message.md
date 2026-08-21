# Hold the Enter behind `dev3 message` until the pane goes quiet

## Context

Agents write to each other in bursts: three or four `dev3 message` sends inside a
couple of seconds. Each delivery typed its text and submitted it 800 ms later
(`AGENT_PROMPT_ENTER_DELAY_MS`), so the receiver started a turn on message 1 while
2, 3 and 4 were still arriving — it answered on partial information, and the rest
landed as interruptions.

## Decision

`deliverAgentPrompt` takes `coalesceSubmit`. With it, the text goes in immediately
and the Enter is held by `src/bun/agent-prompt-submit-coalescer.ts`: one pending
submit per pane, pushed back by every further message, fired after
`AGENT_MESSAGE_SUBMIT_IDLE_MS` (10 s) of quiet and never later than
`AGENT_MESSAGE_SUBMIT_CEILING_MS` (30 s) after the first unsubmitted text. Only the
message paths ask for it (`scheduled-message-scheduler.deliverToTarget`, which
covers both immediate sends and "Send later" fires); Create-PR, commit, rebase and
bug-hunter hand-offs keep their instant submit.

On tmux the held Enter is a delivery of its own against a FRESH pin, because the
pane-input seam caps a program's in-band delays at 2 s (`maxTotalDelayMs`) — ten
seconds cannot live inside one program. It is held only when the text stage came
back `delivered`: a refused text stage leaves an unknown input box. On native the
CR travels through the same bound terminal, and `coalesceSubmit` rides on
`NativePromptDeliveryParams` because the holding must happen in the process that
owns the pane's writer lease.

A human typing into the task's terminal pushes the submit back the same way a
message does: `pty-server`'s WebSocket `message` handler calls
`deferAgentPromptSubmitsForTask` for every keystroke it forwards to the shell. That
handler is the only route human input takes into a pane — our own text goes in via
`tmux send-keys` or the native writer — so the two never get confused. The push-back
is task-wide rather than per-pane on purpose: a tmux client types into whichever
pane is active, so keystrokes carry no pane identity of their own.

## Risks

- **The user types into the pane during the window.** Their keystrokes mix with the
  pending text and our Enter submits the mix. That race existed at 800 ms; it is now
  ten seconds wide. Keystrokes push the Enter back, so it does not land mid-word —
  but if the user submits their own line, the pending Enter still fires later into
  an empty box.
- **Terminal auto-replies count as typing.** Device-status answers the terminal
  emits on its own travel the same WebSocket path, so they can push a submit back
  without a human present. The 30 s ceiling is what bounds this.
- **App death inside the window** leaves the text unsubmitted in the input box —
  the same place a partial delivery has always left it, and visible on screen. The
  pending submit is deliberately in-memory, not persisted.
- **A held submit reports nothing back.** `dev3 message` answers about the TEXT, so
  the CLI now says the submit is pending instead of a bare "Message sent".

## Alternatives considered

- **Buffer the message TEXT for 10 s and paste the burst as one block.** Loses the
  text on app death and hides it from the user until it fires.
- **Coalesce only agent-to-agent traffic** (`source` set). Rejected on the user's
  call: a human sending three `dev3 message` lines in a row has the same problem.
- **Widen `AGENT_PROMPT_ENTER_DELAY_MS` to 10 s.** Would slow every button hand-off
  and still submit once per message.
