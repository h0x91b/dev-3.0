# Live agent traffic orbit

## Context

The approved visualization replaces the traffic log with a 3D project orbit and an inspector. The reference also contains reconstructed messages, authored stories and simulated actions that cannot become production facts.

## Investigation

`AgentMessageLogRow` records delivery attempts with four distinct verdicts, but no read receipts, reply IDs or ownership. Current task records supply role, column and runtime, never historical state or a ranked merge-approval queue. Browser QA found that the older installed primary app writes the shared JSONL without the new push; targeting the new instance confirmed its writer push works. On the tested macOS host, native day-file events worked in Node tests but failed in the actual Bun runtime; directory events also failed and closing their native watcher could stall. A Bun subprocess confirmed that checking directory and day-file metadata once per second detects external appends reliably.

## Decision

`AgentTrafficLog` remains the existing overlay, opened directly by `AgentTrafficIndicator` and the unchanged shortcut; it combines stable project-grouped nodes, accessible lists and an inspector. Show active tasks plus selected-history endpoints; current state stays independent of the message window. Each attempt may pulse once: delivered traverses its route; held, unconfirmed and not-delivered pulse at the sender without claiming receipt.

`watchAgentMessageLog` in `src/bun/agent-message-log-watch.ts` lazily observes read projects and emits the same `agentMessageLogChanged` push for external writes. Metadata checks read no message bodies and unchanged files produce no push; native events complement them outside macOS, immediate writer pushes remain, and shutdown closes observers. Historical endpoints stay inspectable without dead navigation; preserve subject/body and retention evidence, dropping demo narratives and simulated actions.

## Risks

Dense graphs and unavailable WebGL must retain usable task/message lists, and reduced motion must suppress animation. A held record describes its original attempt rather than the current queue; a later message neither acknowledges nor resolves it. Filesystem notification availability varies; read retries reattach unavailable observers without altering shared log paths or formats.

## Alternatives considered

Keeping the old log as a separate presentation would duplicate the same surface; a new destination would exceed the navigation budget. Renderer polling and preview-toasts-as-data were rejected: the durable row owns body and verdict. Writer pushes alone miss other installed versions; filesystem observation covers their shared log writes without migrations or fabricated workflow.
