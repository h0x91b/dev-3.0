# Defer a held message while its tmux pane is in copy mode; never submit a stranded turn

## Context

A held `dev3 message` is typed when its pane goes quiet. If the user had scrolled up at that moment, tmux mouse mode had put the pane in copy mode. The guarded send refused it and reported `incarnation-changed`, like a gone pane, and `release()` in `src/bun/agent-message-hold.ts` deleted the hold. The message was lost, and its sender had already been told `held`.

## Investigation

- **The refusal can be classified in the same server turn.** `if-shell` takes an else command. A `display-message` there, carrying the same identity conjunction with `pane_in_mode != 0`, prints `1` only when copy mode was the sole failed condition. Verified live, including a foreign token on a scrolled-up pane reading `0`.
- **A first version retried the refused Enter, and that was a regression.** Proven live on a disposable shell: the user scrolled up inside the 0.8 s text-to-Enter gap, left copy mode, typed a draft, and dev3's resumed Enter submitted `AGENT-TEXTUSER-DRAFT`.
- **A keystroke CR is no proof of a submission either.** dev3's tmux leaves `mode-keys` to tmux, which picks vi when `$EDITOR` contains "vi". In vi copy mode, Enter copies and exits. Other CRs act on pickers or dialogs.
- **The agent's own prompt-submit hook is the only signal that says the box was submitted.** Every harness hook dev3 installs reaches `recordTerminalPromptSubmission` (`src/bun/agent-terminal-prompt-log.ts`).

## Decision

- `sendKeysGuarded` returns `inMode`, which becomes the retryable reason `pane-in-mode`. Deliveries and submits answer `landed | deferred | failed`.
- **Nothing landed:** the turn is deferred and retried every `AGENT_MESSAGE_HOLD_IDLE_MS`.
- **Text landed but its Enter could not follow:** the turn is **stranded**.
  - dev3 never presses Enter on it: no retry, no ceiling, no silence release.
  - A raw keystroke CR (`flushHeldAgentMessagesForTask`) does not release it.
  - Later messages wait behind it untyped.
  - It is released only by `releaseStrandedAgentMessagesOnSubmission`, called at the top of `recordTerminalPromptSubmission` before its envelope filter, and only when the submitted text contains **every** landed text (`submissionMatchesTypedText`).
  - Each quiet window it probes the pane (`pinTaskPane`), and drops the turn only on proof the pane is gone.
  - Both stranding and drops raise the receiving task's attention badge.
- Every put-back goes through `requeue()`, which puts leftovers in front of a hold that started meanwhile. That fixes the split-burst overwrite (C6).

## Risks

- A stranded turn has no deadline. With no matching hook it waits until the pane dies, and so does everything behind it. That covers harnesses without a prompt hook (Gemini, Cursor Agent), a hook that reaches another app process, a submission whose text differs from what was typed (a collapsed paste, or the user editing the text away), and an app that is offline.
- Whether each harness's hook carries a pasted envelope in full is not observed live. This session's own Claude transcript shows full envelopes, 0 placeholders. A mismatch fails safe: the turn stays held.
- The sender is not told afterwards. It was told `held`, and a new message-log status would be an on-disk schema change. The only record is the receiver's badge plus the app log.
- Normal holds still flush on any keystroke CR, including one in vi copy mode (N1, already on main). That is unchanged here.

## Alternatives considered

- **Retry the Enter:** rejected, because it submits the user's draft (proven live).
- **Pre-forward `pane_in_mode` query on each user CR:** rejected. It is narrowed by a guard interval but still races, misjudges other panes, and ignores pickers.
- **Leave copy mode (`send-keys -X cancel`):** rejected, because it yanks the user out of scrollback.
- **Read or clear the input box:** rejected. Reading is fragile across CLIs, and clearing destroys the draft.
