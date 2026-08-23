# Retune the agent-message coalescing window to 15 s / 60 s

## Context

`hold-the-enter-behind-dev3-message.md` (2026-08-21) shipped the held Enter at
`AGENT_MESSAGE_SUBMIT_IDLE_MS` 10 s and `AGENT_MESSAGE_SUBMIT_CEILING_MS` 30 s.
In use the 10 s window still split bursts: peers writing three thoughts a few
seconds apart at human-relay pace kept landing as two turns instead of one.

The original reasoning is unchanged and still correct — only the numbers were
wrong for the observed traffic, so this is a retune, not a redesign.

## Decision

`src/shared/agent-message-coalescing.ts`: idle 10 s → **15 s**, ceiling 30 s →
**60 s**. The algorithm in `agent-prompt-submit-coalescer.ts` is untouched, and the
values stay constants — deliberately not user-configurable.

The prose that quotes the window no longer restates it. A derived
`AGENT_MESSAGE_SUBMIT_IDLE_SECONDS` is interpolated into the CLI's "sent" line
(`src/cli/commands/message.ts`), the injected skill body
(`src/shared/agent-skill-content.ts`) and the `ask-dev3` skill
(`src/bun/agent-skills.ts`). The 10 s retune found four hand-written "ten seconds"
in that text, two of them in the skill files dev3 writes into every agent's config
dir on startup — agents were being instructed to expect a number the code would no
longer honour, which pushes them to peek at or chase a peer still inside the real
window. That is agent behaviour, not a doc typo. `agent-prompt.ts`'s comment about
the 2 s in-band delay cap dropped its number instead: the relationship (window ≫
cap, so the Enter cannot live inside one pane-input program) is what matters and
holds harder at 15 s.

A fifth site was coupled to the window and no prose grep could have found it: the
live e2e `native-message-owner-routing.bun-e2e.ts` waited a hardcoded `15_000` ms
for the held CR. At the old 10 s window that was 5 s of headroom; at 15 s it became
a photo finish against the window itself — it passed locally and failed on the CI
macOS runner. Now derived (`AGENT_MESSAGE_SUBMIT_IDLE_MS + 10_000`). A **timeout**
that waits on the window is as coupled to it as the prose is; the next retune
should grep for `_000` deadlines in the live e2e set, not only for words.

Two guards, each proven by breaking what it guards:
`agent-skills.test.ts` asserts the rendered skill bodies (all four variants) carry
`~${AGENT_MESSAGE_SUBMIT_IDLE_SECONDS}s of quiet` and no stale spelled-out number;
`src/cli/__tests__/message.test.ts` keeps a deliberate **literal** `15s of quiet`
as a canary, so retuning the constant fails a test and forces the author to look.

## Risks

- **Worst case is now a full minute.** The ceiling went from 3× the idle window to
  4×, so a stream of senders each arriving inside the window holds the receiver's
  Enter for 60 s. Reachable, not theoretical: it needs traffic at under-15 s
  intervals for a minute, one more sender than before. That is the trade asked for.
- **A relay chain costs more.** A peer's reply starts ~15 s after it writes, so a
  three-agent chain is ~45 s of pure window instead of ~30 s.
- **The typing race is wider**, exactly as the original record described — 15 s
  instead of 10 s during which a user's keystrokes can mix with pending text.
  Keystrokes still push the Enter back and the ceiling still bounds it.

## Alternatives considered

- **Amend the 2026-08-21 record in place.** Rejected: that record's reasoning is
  still the live reasoning, and rewriting its numbers would erase the fact that the
  first pick was measured in use and found short.
- **Make the window configurable.** Rejected — durable config for a constant this
  project has already declined once; the ask was different values, not a setting.
- **Leave the prose and only bump the constants.** Rejected: that is the exact
  drift this retune exposed.
