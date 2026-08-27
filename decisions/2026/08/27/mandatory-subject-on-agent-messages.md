# A mandatory subject on every agent message

## Context

Agent-to-agent traffic has had a durable log for a while (`data/<slug>/messages/*.jsonl`) and, since
the agent-traffic readout shipped, two surfaces that render it: the header popover and the traffic
log (`⇧⌘M`). Both give one pair one line of text, and that line was the head of the message body.

In practice every line was useless. Agents open a message by naming themselves and their task —
exactly the two things the row already shows either side of the wire — so real rows read:

```
#1141 -> #1716   Coordinator Seq 1141 (47205843) - ACT...      x11  2m
#1722 -> #1141   Seq 1722 -> Coordinator: CI VERDICT - P...    x14  3m
```

The reader learns nothing a row without any text would not have told them.

## Decision

**A one-line subject is required on every `dev3 message`, stored with the message, and it is what
both traffic surfaces render.**

- The flag is **`--subject`**, not `--title`. `--title` already means *the task's* title in this CLI
  (`dev3 task create/update --title`), and reusing it would make "the title" ambiguous in help text,
  in docs, and inside an agent's head, where "set the title" is already an instruction about the
  task. `--subject` is what mail and ticket systems call a one-line summary of a message.
- **The cap is 80 characters, enforced hard; "about six words" is guidance only.** Word counting
  across languages is a trap — six words of Russian and six of English do not carry the same meaning,
  so a word rule would reject honest subjects in one language and wave through bloated ones in
  another. Whitespace (newlines included) is collapsed, which is formatting, not meaning.
- **Over the cap is rejected, never truncated.** A clipped subject is a sentence the author did not
  write, and the field's whole value is that a human reads it later and trusts it. Rejection costs
  one retry; a silent clip costs the meaning, invisibly. The same reasoning forbids deriving a
  subject from the body when one is absent.
- **The error is the deliverable.** Every agent alive has the subject-less habit, so it is the common
  path, not an edge case: it names the requirement, prints the cap, shows a good and a bad example,
  suggests a subject taken from the caller's own text with the self-address stripped (labelled as a
  starting point), and prints the corrected command with the caller's own target flags. It has its
  own exit code, **17** (`CLI_EXIT_CODE_MESSAGE_SUBJECT_REQUIRED`), so a wrapper can recognise this
  one case instead of treating it as a misspelled command.
- **No compatibility mode**, per the no-deprecation rule. The CLI validates locally and the app
  validates every socket send from the same pure module (`src/shared/agent-message-subject.ts`), so
  an older `dev3` binary is told to update rather than quietly writing a subject-less row.
- **Nothing is backfilled.** Rows written before this keep rendering their body head.

Where it lives: `src/shared/agent-message-subject.ts` (cap, validation, error text, suggestion),
`src/cli/commands/message.ts` (`requireSubject`), `src/bun/cli-socket-server.ts`
(`requireMessageSubject` on `message.send` / `message.schedule`), `ScheduledMessage.subject` and
`AgentMessageLogRow.subject`, `wrapAgentMessage`'s `<subject>` tag, `agentReplyCommand` (the printed
reply command carries the flag), and `rowHeadline` in `agent-traffic/TrafficRow.tsx`.

## Risks

- **Every existing caller breaks once.** That is the intended cost, and the error is written to be
  the fix rather than a complaint. Any in-repo caller that prints a `dev3 message` command was
  rewritten in the same change, or a copy-paste would fail.
- **The subject can be lazy** ("update", "status") and nothing can stop that. The help text and the
  skill therefore spend their words on *what not to write* — never repeat who is talking — because a
  row that restates the pair is the failure this exists to prevent.
- **An 80-character cap will annoy someone.** It is a deliberate over-provision of the six-word
  guidance so that the hard rule almost never fires on an honest subject.

## Alternatives considered

- **`--title`** — rejected for the collision described above.
- **Optional, with a body-derived default** — rejected: an auto-subject is indistinguishable from a
  chosen one, so the column would look full while carrying nothing, which is today's bug with extra
  steps.
- **Silent truncation over the cap** — rejected: it destroys the author's meaning invisibly. A hard
  reject in the middle of automation is hostile, which is why the cap is generous and the error
  prints the command to re-run.
- **A word-count rule** — rejected as language-dependent (see above).
- **Reusing exit 3 (usage error)** — rejected: this is the one failure every existing caller hits, so
  a wrapper that wants to retry with a subject needs to tell it apart from a typo.
- **Deriving the row's line in the renderer instead of storing a subject** — rejected: that is what
  the old body head was, and no render-time heuristic can recover a summary the sender never wrote.
