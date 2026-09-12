# The task's conversation is read in the traffic inspector, from two stores

## Context

The Agent traffic inspector showed the messages agents send each other and a list of tasks,
but not what an agent and its human actually said — the record the user most often wants when
a node looks wrong. There was no conversation viewer anywhere in the renderer to reuse: the
parsers (`src/shared/conversation-parsers/`), the model (`conversation-model.ts`) and the
archiver (`conversation-archive.ts`) all existed, but every consumer was a CLI command or an
importer.

## Investigation

Transcripts are not a message log. The largest on this machine is 138 MB and one turn can
carry a whole file, so "show the conversation" has no bounded meaning. Measured on this
machine while building it: discovery of a worktree's transcripts ~370 ms warm, parsing a
72 MB Codex transcript ~130 ms, a whole request 262–348 ms warm — but **20.6 s on the first
cold read** of a 78 MB pair of files. Nothing is cached: holding several parsed transcripts in
the main process would cost hundreds of megabytes for a panel opened occasionally, and a warm
re-parse is cheap.

A finished task has no worktree and no native transcript — Claude prunes its own on a ~30-day
window — but it does have dev3's dump, written once when it went terminal. That dump is a
*projection*: tool payloads are cut by policy, so a reader must be told which store answered.

## Decision

A third inspector tab, `Conversation` (`TrafficConversation.tsx`), over one new read-only RPC
`readTaskConversation` (`src/bun/task-conversation.ts`). It returns the newest session first,
one page of 25 turns paged backwards, each message clamped to 1200 characters, and tool calls
counted with their native names rather than replayed. `src/shared/task-conversation-model.ts`
holds the pure part and deliberately types a turn as the *intersection* of a live parse and a
dump, so one builder serves both stores. A live transcript wins over its own archived copy of
the same session. Empty means "nothing readable was found", said in those words — never an
empty list that reads as silence.

## Risks

- The first read of a very large transcript can take tens of seconds (measured 20.6 s cold);
  the tab shows its loading state and the RPC timeout is two minutes, so it resolves, slowly.
- Only Claude Code and Codex transcripts parse. Another harness shows the honest empty state,
  not an error — and not a claim that the agent said nothing.

## Alternatives considered

- **A full-screen conversation surface** (like `TaskDiffViewer`): a whole destination and a
  history step for what is a glance inside a panel. Rejected as out of proportion; the cap plus
  "open the task" is the escape hatch.
- **Mixing conversation turns into the Messages list**: destroys the distinction the traffic
  screen exists to make — peer traffic is attempts between agents, a transcript is one agent's
  own record.
- **Caching parsed conversations per task**: buys a warm re-parse of a few hundred milliseconds
  at a cost of hundreds of megabytes of resident memory. Rejected.
