# Prove a terminal prompt is the user by subtraction, with receipts

## Context

Agent traffic shows agents talking to each other. The human who starts most of those turns is
invisible, so a graph of a working day reads as machines conversing with nobody. The obvious
source of that missing half is the harness's own `UserPromptSubmit` hook, which dev3 already
installs on Claude Code and Codex — the two harnesses of five that have hooks at all.

The hook cannot answer the question it looks like it answers. It fires for whatever was submitted
in the pane, and dev3 types into that pane constantly: peer `dev3 message` deliveries, the
Send-to-agent button, the Send-later modal, PR and rebase hand-offs, artifact replies, held
bursts. Two earlier proposals were rejected before this one: a per-pane timing window (its failure
mode is a silent false "the user said this"), and treating the absence of a `<dev3-ai-message>`
envelope as proof of a human (it is only proof of the negative case).

## Investigation

Measured against claude 2.1.267 and codex-cli 0.153.4 rather than assumed:

- Claude Code **does** fire `UserPromptSubmit` for a prompt supplied as a launch argument —
  verified with a capture hook for both `claude -p "<text>"` and an interactive `claude "<text>"`.
  Left alone, every task's own description would have been recorded as the user's first message.
- The Claude payload carries `prompt` and `prompt_id`, a stable per-submission id.
- **The harness submits prompts of its own.** Finishing a Task subagent raises a SECOND
  `UserPromptSubmit` in the same session carrying `<task-notification>…`, with its own `prompt_id`
  and nothing marking it as generated — observed, not theorised. dev3 typed none of it, so no
  receipt can cover it and only the shape of the text can.
- Codex's `user-prompt-submit.command.input` schema, read out of the shipped binary, requires
  `prompt`, `session_id` and `turn_id`. Schema-verified, not observed live: `codex exec` fires no
  hooks, and observing one live would mean editing the user's global `~/.codex/config.toml`.

## Decision

dev3 answers the hook by elimination, and keeps a receipt for every elimination.

- `noteDev3TypedPrompt` (`src/bun/agent-typed-prompt-claims.ts`) records the text of every prompt
  dev3 causes: once at `deliverAgentPrompt` — the single seam every delivery passes through — and
  once per launch site in `rpc-handlers/tmux-pty.ts` for the brief and a column agent's prompt.
- `recordTerminalPromptSubmission` (`src/bun/agent-terminal-prompt-log.ts`) throws a submission out
  if it opens with a dev3 envelope, if it opens with ANY pseudo-XML tag, if it consumes a receipt,
  or if its submission id was already seen.
- The tag rule (`looksMachineGenerated`) is wider than any list dev3 could keep current, but it is
  **not sufficient** — see the falsified assumption below. It catches the tagged harness prompts
  and nothing else.
- What survives every one of those tests is stamped `origin: "user"` and written as an ordinary
  message-log row.
- Matching is by containment with length floors (`src/shared/agent-terminal-prompt.ts`), because
  the pane composes: a burst joins several deliveries, a board snapshot trails them, the harness
  appends its protocol body to a launch argument. Receipts are consumed, so two identical sends
  need two receipts.
- Claude gets a **second** `UserPromptSubmit` hook entry (`dev3 hook claude-prompt`) beside the
  status move, which is untouched. Codex carries the prompt on its existing `task.agentHook`
  payload and costs the pane no extra process.
- Only a clamped one-line preview is stored. The prompt body is read in-process to classify it and
  dropped — recording every prompt would be a far wider data set than the message log and would
  routinely capture pasted secrets.

## Falsified after this was written — the guarantee is not established

The assumption that harness-generated prompts are recognisable by shape did not survive contact.
Seq1863's teammate experiment (2026-09-10, raw payloads in
`/Users/arsenyp/dev3-reports/teammate-message-origin/`) observed a `UserPromptSubmit` in the lead's
own session that nobody typed: 5 898 characters opening with `# Autonomous loop check`, plain
Markdown, no tag. Its payload keys are **byte-identical** to a human prompt's — `cwd`,
`hook_event_name`, `permission_mode`, `prompt`, `prompt_id`, `scratchpad_dir`, `session_id`,
`transcript_path` — so there is no structural field to branch on. What triggered it is unknown and
one bounded retry did not reproduce it.

Consequence, stated plainly: **dev3 cannot prove that an unclaimed, untagged submission came from a
human.** Subtraction bounds what dev3 caused, not what the harness causes.

### The owner decided the looser rule is what he wants

Asked to choose between narrowing the field to a provable `"terminal"`, parking the feature, and
building positive keystroke evidence, Arseny ruled (verbatim, 2026-09-10):

> «Я не очень понимаю, в том плане, что если тебе кто-то послал при помощи dev3 message-а, то он в
> XML-е обёрнутый. А все остальные случаи можно считать спокойно за юзера. То есть даже если ты сам
> себе сделаешь postpone сообщения обратно, ну типа сделал postpone, чтобы сообщение послалось через
> 5 минут, ну хер с ним, пусть он показывает, как будто от юзера.»

So `origin: "user"` stays, and the residual imprecision is accepted by the person it misleads: a
peer message is excluded because it is wrapped, and everything else counts as him. The
`# Autonomous loop check` prompt would be shown as his — that is the accepted cost, not an
oversight. A text-prefix blacklist remains rejected: it would grow forever behind a harness nobody
controls, and the tag rule already removes the obvious machine chatter (subagent completion
notices) without pretending to be exhaustive.

The same experiment closed the teammate question in the other direction: a teammate *delivery* does
not raise `UserPromptSubmit` at all, only text a human types in the teammate's pane does. The
session-mismatch guard this record proposed as future work is therefore unnecessary and was not
built.

## Risks

- **Over-suppression is the chosen failure direction.** A human prompt that quotes something dev3
  typed, or that is submitted while a dev3 message sits unsent in the input box, loses its row.
  That costs one missing row; the opposite error writes a peer's words down as the user's.
- **Two app processes on one task.** A forwarded native delivery now leaves a receipt on the owner
  side as well (`deliverNativePromptAsOwner`), so whichever process the hook reaches can answer for
  the text. What remains unhandled is a receipt left in a third process that neither decided nor
  typed.
- **Codex is schema-verified only.** If the live payload differs from the shipped schema, Codex
  simply records nothing — the prompt field is optional on the wire.
- Three of five harnesses (Cursor Agent, Gemini CLI, OpenCode) have no hooks, so their terminal
  prompts stay invisible. Stated, not worked around.
- **Untagged harness prompts are recorded as the user**, and the payload offers nothing to
  distinguish them from a human's. Accepted by the owner rather than solved; see his ruling above.
- **Nothing has been observed end to end in a running app.** Every dev3-side behaviour above is
  covered by unit tests only; what was verified live is the harness half (which payloads arrive,
  and when).

## Alternatives considered

- **Timing window against `deliverAgentPrompt`** — rejected in report 02: a mismatch is silent and
  falsely attributes a peer's message to the user.
- **Envelope absence as proof** — only sound in the negative direction; it says nothing about the
  UI send paths, hand-offs or the launch brief, all of which are unwrapped.
- **Suppressing the first prompt of a session** — a blanket rule that both misses a second launch
  path and eats a real first human prompt.
- **Folding recording into the existing status-move hook** — one command, one blast radius: a bug
  in recording would then cost every task its board status.
