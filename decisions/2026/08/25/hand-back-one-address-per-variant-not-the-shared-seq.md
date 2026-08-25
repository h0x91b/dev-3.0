# Hand back one address per variant, not the shared seq

## Context

The approval dialog an agent gets on `dev3 task move --status in-progress` (and `task create --scratch
--run`) now lets the user turn one launch into a variant group. That is invisible in the dialog but
changes the protocol: the blocked CLI used to print one seq and one reply command, and with N variants
there are N live tasks answering to the same seq.

`agentReplyRef` already refuses to emit `seq:<N>` while another live task shares it
(`address-a-peer-by-seq-unless-the-seq-is-shared`), so the old single-value shape would either hand out
a UUID that names one arbitrary variant, or a seq the CLI rejects as ambiguous on first use.

## Investigation

`findTaskByRef` (`src/bun/cli-socket-server.ts`) resolves `seq:<N>` only when exactly one task matches
and throws otherwise, so an ambiguous handle fails loudly rather than reaching the wrong agent. The
launch path already read the board *after* launching for exactly this reason — it just had nowhere to
put more than one answer.

## Decision

`LaunchApprovalOutcome` carries `launched: Array<{ variantIndex, replyCommand }>` — one entry per task
that started, in variant order, with the seq and title alongside as group-level facts
(`requestAgentLaunchApproval`). Each `replyCommand` comes from the existing `agentReplyCommand` with
`seqIsShared` counted against the post-launch board, so the id form appears only when it is genuinely
needed. `reportLaunchOutcome` (`src/cli/commands/task.ts`) prints the single-launch wording unchanged
for one entry, and for several says the seq is shared and lists `variant #N  <command>` per row.
`deliverLaunchHandoff` now runs per launched task — every variant is a separate agent that has to know
who started it.

## Risks

- The requester sees N addresses and must fan its own messages out; nothing tells it which variant is
  "the" one, because nothing knows yet.
- The addresses are stamped at approval time. Dropping variants later makes the survivor's seq
  unambiguous again while the requester still holds a UUID — that keeps working, it is only wordier.
- If `dev3 message --task seq:N --variant i` ever lands (Seq 1661), these commands become the verbose
  form of the same thing. They stay correct; only `agentReplyRef` would need to change, in one place.

## Alternatives considered

- **Return only the first variant.** One line of output, and the requester silently never talks to
  variants 2..N — the exact failure the shared-seq record was written to stop.
- **Return the shared seq and let the requester discover the ambiguity.** Its first `dev3 message`
  errors out; loud, but it spends a whole turn learning something we already knew.
- **Forbid variants on an agent-requested launch.** Cheapest, and it refuses the feature the user asked
  for.
