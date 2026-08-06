# 177 — Cross-task agent messages carry a pseudo-XML envelope

## Context

`dev3 message --task seq:N "..."` types text straight into another task's agent
pane. The receiver could not tell an agent-authored message from something the
human typed, and had no address to answer at — replies went nowhere.

## Decision

When `dev3 message` runs inside a worktree, the CLI attaches its own task id as
`sourceTaskId` (`src/cli/commands/message.ts`). The app resolves both ends
(`resolveAgentMessageSource` in `src/bun/cli-socket-server.ts`); if the sender
exists and differs from the target, delivery wraps the text via
`wrapAgentMessage` (`src/shared/agent-message-envelope.ts`):

```
<dev3-ai-message>
<from-task>seq:1310</from-task>
<from-title>…</from-title>
<reply-with>dev3 message --task seq:1310 "your reply"</reply-with>
<message>
…verbatim body…
</message>
</dev3-ai-message>
```

Wrapping happens at **delivery** time (`deliverToTarget` /
`sendMessageImmediately` in `src/bun/scheduled-message-scheduler.ts`), so a
scheduled message stores the plain text (`ScheduledMessage.source` holds the
sender) and the card chip preview stays readable. Length validation also runs on
the raw text, so the envelope cannot push a message over the cap.

## Risks

- A human running `dev3 message --task other` from inside a task terminal is
  attributed to that task's agent — acceptable; the human sends from the UI.
- The body is verbatim: a message containing `</message>` can confuse the
  receiver. Only metadata tags are escaped; agents read prose, not a parser.

## Alternatives considered

- Wrap in the CLI: simplest, but the stored scheduled text and its UI preview
  would show markup.
- Wrap in the app without CLI help: the app cannot know which task the sending
  process lives in — worktree context is a CLI-side fact.
