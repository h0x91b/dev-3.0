# Address a peer by seq unless the seq is actually shared

## Context

The cross-task envelope (`decisions/2026/07/26/cross-task-agent-message-envelope.md`) tells the receiving
agent how to answer: `<reply-with>dev3 message --task <ref> "your reply"</reply-with>`. `agentReplyRef`
picked that ref, falling back from the readable `seq:<N>` to the raw task id whenever
`variantIndex != null`, because every variant of one logical task shares a seq and the CLI rejects an
ambiguous `seq:<N>`.

## Investigation

Reported from a live board: task Seq 490 in `base44` handed out
`--task 824c6557-59be-47ca-ac0e-f7db974cfe08`. Reading `tasks.json` for that project, its group
(`groupId 87c65640…`) had exactly **one** member and exactly one task answered to seq 490 — the
survivor of a variant run whose siblings the user dropped. `variantIndex: 1` is permanent; the
collision it was minted with is not. `findTaskByRef` (`src/bun/cli-socket-server.ts`) already resolves a
seq that matches one row and only throws when several match, so the guard was strictly pessimistic:
it spent a UUID on the *common* shape of a variant task.

## Decision

`agentReplyRef(task, seqShared)` now takes the answer instead of guessing it: the id form is used only
when another live task on that board still answers to the same seq. `seqIsShared()` (both in
`src/shared/agent-message-envelope.ts`) counts that against a task list, and the two callers in
`src/bun/cli-socket-server.ts` — `resolveAgentMessageSource` for the envelope and the launch-approval
`replyCommand`, via `isSeqSharedOnBoard` — read the board to supply it. The launch path reads it *after*
`launchTaskWithAgentChoice`, because launching with variants is what mints the siblings.
`AgentMessageSource.seqShared` carries it into queued scheduled messages.

## Risks

- A queued scheduled message written before this field exists has no `seqShared`; it keeps the old
  pessimistic `variantIndex` behaviour (`source.seqShared ?? source.variantIndex != null`).
- The flag is stamped at send time. If a variant group grows between queueing and delivery, the ref
  goes stale — but the failure is loud: `findTaskByRef` answers "matches N variant tasks, address one
  of them by id", never a silent wrong task.
- An unreadable board falls back to the pessimistic guess rather than risking an ambiguous seq.

## Alternatives considered

- **Recompute at delivery time in `deliverToTarget`.** More correct for long-queued messages, but it
  puts a project load behind the one shared delivery seam (mocked in every scheduler suite) to fix a
  window measured in minutes.
- **Teach the CLI `--variant <n>` so `seq:490 --variant 1` is addressable.** Orthogonal and still
  worth doing; it does not remove the need to stop emitting a UUID when nothing collides.
- **Drop the fallback entirely and always emit `seq:<N>`.** A live variant group would then hand out
  an address that errors on first use.
