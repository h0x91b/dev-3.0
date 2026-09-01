# The handoff pointer rides the launch command, not the pane

## Context

"+ Agent" with "Continue this task's conversation" writes a retelling of the task's
newest transcript and points a freshly spawned agent at it. The pointer used to be
delivered by `deliverAgentPrompt(..., { hold: true })`: nothing typed now, everything
typed once the new pane went quiet — the hold standing in for "the agent finished
booting", because a fixed sleep would guess at it.

The user reported the takeover never starting: the new agent just sat there until he
typed into the chat.

## Investigation

The app log of his actual run (task `48a9aee4`, 2026-09-01):

- `07:55:14.830` — `agent message held`, `delayMs 15000`, `humanHeld false`.
- `07:55:22.863` onward — a stream of `agent message deferred by human typing`,
  `delayMs 60000`, one per keystroke.
- `07:55:35.972` — `agent message released by the user's own submit`.

`deferHeldAgentMessagesForTask` is task-wide by design (a tmux client types into
whichever pane is active, so keystrokes carry no pane of their own). The user was
typing in the pane he spawned the takeover *from*, which pushed the new pane's hold
back by a full 60s window every keystroke and set `humanHeld`, dropping the ceiling
entirely. The pointer could only land on his Enter. The hold is right for a peer's
`dev3 message`; it is wrong for a pane the user is not typing into and whose whole
purpose is to start working.

## Decision

`spawnAgentInTask` (`src/bun/rpc-handlers/tmux-pty.ts`) now puts `handoffPrompt(handoff)`
into the `TemplateContext.taskDescription` it resolves the launch command with, exactly
as a task's first launch carries its description. Every adapter already routes that
through `buildTaskPrompt`, so it works for all six harnesses and on both terminal
backends, and the delivery verdict becomes a plain `delivered` (`reason: "launch-prompt"`)
with nothing typed into the pane at all. In the project-default branch the handoff
prompt replaces the task description rather than joining it — the retelling already
carries the original request.

## Risks

The pointer now spends command line, which is budgeted on Windows
(`AGENT_COMMAND_LINE_RESERVE`, 5 000 characters). It is one sentence plus a path —
roughly 500 characters against a reserve that exists for a whole task description, and
a spawned agent has no description of its own. The retelling itself never travelled
this way and still does not.

## Alternatives considered

- **Exempt the handoff hold from the human-typing defer** (a non-deferrable hold). Keeps
  the boot race the hold was invented to paper over, and 15 seconds stays a guess.
- **Make the defer per-pane instead of task-wide.** Wide blast radius across peer
  messaging, and tmux keystrokes genuinely do not carry a pane of their own.
