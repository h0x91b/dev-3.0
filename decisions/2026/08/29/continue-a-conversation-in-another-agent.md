# Continue a conversation in another agent — a pane, a file, and a held pointer

## Context

Users want to start work in Claude Code and finish it in Codex, or the reverse,
without re-explaining anything. The retelling machinery already landed
(`renderHandoff`, `dev3 conversations handoff`, PR #1453); nothing drove it from the
UI. Three separate questions had to be answered before writing code: where the new
agent runs, how the retelling reaches it, and when.

## Investigation

A native cross-client resume is impossible and was not attempted: `--resume` reads
only its own store, Claude signs its reasoning blocks so they cannot be forged, and
the tool sets do not intersect (Claude has `Read`/`Write`/`Edit`, Codex shells out and
patches). That was settled in the parent task and is restated in
`src/shared/conversation-render.ts`.

The parent conversation of that work renders to 359 KB with tool output dropped
entirely, so "one big message" is not a delivery option: pane input truncates long
bodies, and a body that size would eat most of a fresh context window anyway.

## Decision

**A second pane in the same task, not a new task.** The work being continued lives in
this worktree, with uncommitted changes on this branch. A new task gets a fresh
worktree off the base branch and could not continue anything — it would be a copy of
the conversation next to none of the work. `spawnAgentInTask`
(`src/bun/rpc-handlers/tmux-pty.ts`) already opens an extra agent pane in the task's
own terminal, so the feature is one optional flag on it rather than a second launch
path. Importing a conversation that belongs to *no* task is the other shape, and it
already exists (`conversation-import-handlers.ts`) — the two do not overlap.

**A file plus a pointer, never the text.** `prepareTaskHandoff`
(`src/bun/conversation-handoff.ts`) writes the retelling to
`<taskContainer>/conversations/handoff-<source>-<session>.md` — the durable directory
that outlives the worktree — and `handoffPrompt` builds the one line typed into the
new pane. `renderHandoffFile` caps the body at `HANDOFF_FILE_LIMIT` (120 000
characters, about 30k tokens) by dropping leading turns, the same head-plus-tail fit
`renderImportedDescription` uses, so the request that started the work always survives.

**Written before the pane is opened.** A conversation that cannot be retold fails with
nothing created, instead of leaving a bare agent standing where the user asked for a
takeover.

**The pointer is held, not slept on.** Delivery goes through `deliverAgentPrompt` with
`{ hold: true }`, so the line lands when the new pane goes quiet — which is what "the
agent finished booting" looks like from outside. The bug-hunter path guesses that with
a fixed 5-second sleep; a hold is both more robust and returns immediately, so the
dialog does not block. `held` is a success verdict, not a pending one.

## Risks

- A held pointer that never lands leaves an agent sitting in the worktree with no
  brief. It is reported (`spawnAgent.handoffNotDelivered` names the file path) rather
  than swallowed, and the pane is kept — killing a live agent on a delivery guess is
  worse than the missing line.
- The 120 000-character cap is a judgement, not a measurement. A very long session is
  handed its tail, and the renderer states how many turns it dropped.
- The retelling is only as good as the parser. `renderHandoff` stamps the parser
  version and the fidelity warnings into the file's footer, so a takeover reading a
  `partial` parse can see that it is one.

## Alternatives considered

- **Forge a native transcript the other client can resume.** Impossible, see above.
- **A new dev3 task per switch.** Rejected: no access to the work in progress.
- **Deliver the retelling as one typed message.** Rejected: `dev3 message` and pane
  input truncate long bodies silently, and the smallest useful retelling is already
  tens of thousands of characters.
- **A dedicated button or menu item.** Rejected: the `session_agent` bar of
  `TaskInfoPanel` is at its documented four-control budget, and toolbar-button creep is
  the manifest's first-named anti-pattern. The option rides on the "+ Agent" dialog it
  modifies, and is rendered only when the task has a conversation to hand over.
