# Stamp message origin at the call site, never infer it from a missing sender

## Context

Agent traffic could show one task talking to another, but not the user talking to
a task, even though the user's messages were already on disk: every send goes
through one seam (`recordMessageAttempt` in `src/bun/scheduled-message-scheduler.ts`)
and every send is logged, sender or no sender. What was missing was any way to say
*who* sent a row that has no sending agent.

The tempting shortcut is that `fromTaskId === null` means the user. It does not.

## Investigation

Enumerated every path that reaches the delivery seam with no `AgentMessageSource`:

| Path | Actually is |
|---|---|
| `sendAgentMessageNow` (`rpc-handlers/pr-comments.ts`) — the diff viewer's "Send to agent" | the user |
| `scheduleMessage` (`rpc-handlers/git-operations.ts`) — the "Send later" modal | the user |
| `sendArtifactMessageToAgent` (`rpc-handlers/artifact-messages.ts`) | a human, but a published artifact reaches anyone the link reached |
| `dev3 message` run outside a worktree (`cli-socket-server.ts`) | unknown — an agent with a wrong `cwd` produces a byte-identical call |
| `deliverLaunchHandoff` (`agent-launch-handoff.ts`) | dev3 itself |

Four of the five wear the same face at the seam. Reading the shape of the row
therefore mislabels three of them.

## Decision

`AgentMessageLogRow.origin?: AgentMessageOrigin` (`src/shared/agent-message-log.ts`),
optional and additive, stamped **by the caller** and only by a caller that can
prove a human acted — currently the two handlers above. `isUserOrigin()` in that
same file is the single predicate; the renderer, the traffic store and the graph
model all call it rather than comparing inline, so the rule cannot be re-derived
differently in three places.

`ScheduledMessage.origin` carries the same value through `tasks.json`, because a
"Send later" fires hours after it was authored and nothing at fire time could
tell who wrote it.

In the graph, `fromKey()` returns a synthetic per-project endpoint
(`USER_ENDPOINT_ID`, `traffic-model.ts`) for a proven user row, so the existing
layout, edge routing, flight animation and replay all work unchanged. The marker
renders as its own `UserCard` in `TrafficNodes.tsx` rather than a branch inside
`Card`: it shares none of the task grammar there, and routing a human through the
task card printed "status not recorded" and `#—` about a person.

## Risks

- **The safe direction is asymmetric.** An envelope-wrapped or agent-sent message
  is provably not the user; an *unmarked* row is merely unknown. Any future caller
  that stamps `origin: "user"` without proof puts a false claim in a durable log.
  The predicate and the two call-site tests exist to make that visible in review.
- A task whose id literally equals `dev3:user` shadows the marker in that project.
  The task wins, which is the safe direction, and it is covered by a test.
- Experiment 1 (`TrafficOrbit`) draws the user as an ordinary orb; only its label
  is corrected to "You". A dedicated mesh treatment is deliberately not in this
  change.

## Alternatives considered

- **Infer from `fromTaskId === null`.** Rejected: mislabels three paths, including
  dev3's own hand-off, and the mislabelling is silent and durable.
- **Derive origin from harness `UserPromptSubmit` hooks.** A real option and the
  subject of a follow-up task, but it identifies nothing on its own: the hook fires
  for anything typed into the pane, and dev3 types into panes constantly
  (see the comment at `agent-prompt-delivery.ts:66`). It also needs dedup against
  the two paths above, which already write a row for the same submission.
- **Store the full prompt body for every submission.** Rejected here as a scope
  widening that would routinely capture pasted secrets; it deserves its own
  decision rather than arriving as a side effect.
