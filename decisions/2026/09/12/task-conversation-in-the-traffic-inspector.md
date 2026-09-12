# The task's conversation is read in the traffic inspector, from two stores

## Context

The Agent traffic inspector showed the messages agents send each other and a list of tasks,
but not what an agent and its human actually said — the record the user most often wants when
a node looks wrong. There was no conversation viewer anywhere in the renderer to reuse: the
parsers (`src/shared/conversation-parsers/`), the model (`conversation-model.ts`) and the
archiver (`conversation-archive.ts`) all existed, but every consumer was a CLI command or an
importer.

## Investigation

Transcripts are not a message log. The largest on this machine is 138 MB and one turn can carry a
whole file, so "show the conversation" has no bounded meaning.

The first build parsed **every** transcript of the worktree just to list the sessions, and its first
read of a large task took **20.6 s**. Phase timings on the same machine, warm, say where the time can
and cannot be: discovering a worktree's transcripts costs 271–484 ms (dominated by the Codex locator,
which reads the first 4 KB of all 975 rollout files on this machine to map cwd → file); reading a
72 MB transcript costs 15 ms; parsing it costs 130 ms. Warm, the whole request is ~200–620 ms — so the
20.6 s was **not** reproducible warm and is not explained by parse cost.

What remains unproven is the exact split of that 20.6 s: purging the page cache needs root, so a
genuine cold repeat could not be staged. The honest statement is that it was a cold first read of
79 MB plus ~1 000 small files on a box at load average 15, and that the fix below removes the part
that was certainly wasted — the other sessions.

## Decision

A third inspector tab, `Conversation` (`TrafficConversation.tsx`), over one new read-only RPC
`readTaskConversation` (`src/bun/task-conversation.ts`). It returns the newest session first, one page
of 25 turns paged backwards, each message clamped to 1200 characters **with the number of cut
characters shown**, and tool calls counted with their native names rather than replayed.

**Listing is separate from loading.** The picker is built from file names and `stat` alone — both
stores put the session id in the name (`<uuid>.jsonl`, `<source>-<uuid>.json`) — so listing six
sessions opens zero files, and exactly one file, the selected session, is ever read and parsed.
`src/shared/task-conversation-model.ts` holds the pure part and types a turn as the *intersection* of
a live parse and a dump, so one builder serves both stores. A live transcript wins over its own
archived copy of the same session. Empty means "nothing readable was found", said in those words.

Renderer side, two rules keep the host cost down: a request is debounced 250 ms, so arrowing through
nodes fires one read (measured: 4 node clicks → 1 host read), and a response for a task or session the
user has already left is dropped rather than rendered under the new heading. Both, and the debounce
interval, are covered by mutation-checked tests.

## Risks

- The listing still pays the Codex locator's index build (271–484 ms warm, and the likeliest suspect
  for most of a cold read). Fixing that means changing discovery for search as well, which is a
  larger change than this panel justifies.
- A single very large session still costs its own read; that is now the worst case instead of the sum
  of every session.
- Only Claude Code and Codex transcripts parse. Another harness shows the honest empty state.
- **A shortened message has no "see the rest" destination, and the copy no longer claims one.** The
  first wording said "open the task for the whole text"; that is false wherever it matters most. A
  completed task's worktree and terminal are gone (`TaskTerminal` answers `worktree-gone`), and an
  older handoff session was never in the pane a running task does have — the pane holds the current
  session's scrollback, bounded by tmux history. So the line states the exact number of characters it
  shortened and stops there. This tab is a preview of the record, not a window onto the file.

## Alternatives considered

- **A full-screen conversation surface** (like `TaskDiffViewer`): a whole destination and a
  history step for what is a glance inside a panel. Rejected as out of proportion; the cap plus
  "open the task" is the escape hatch.
- **Mixing conversation turns into the Messages list**: destroys the distinction the traffic
  screen exists to make — peer traffic is attempts between agents, a transcript is one agent's
  own record.
- **Caching parsed conversations per task**: buys a warm re-parse of a few hundred milliseconds at a
  cost of hundreds of megabytes of resident memory in the main process. Rejected — laziness made the
  re-parse cheap enough that a cache has nothing left to buy.
- **Expanding a clamped message in place**: a second RPC per turn, or shipping the whole turn to the
  renderer anyway. Rejected in favour of saying exactly how much was cut.
