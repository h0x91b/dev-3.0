# `--variant` is a filter on `dev3 message`, not a variant-group mode

## Context

`decisions/2026/08/24/address-a-peer-by-seq-unless-the-seq-is-shared.md` stopped handing out a raw
UUID unless the seq is genuinely shared, and listed "teach the CLI `--variant <n>`" as the orthogonal
follow-up. This is that follow-up. Arseny fixed the scope verbatim: "Только у `dev3 message`" — a
shared `--task` contract across every CLI command was rejected as too much surface for the value.

## Investigation

`findTaskByRef` (`src/bun/cli-socket-server.ts`) is shared by `task show/move/update`, `note`,
`overview`, `label`, `peek`, `pane` and the hooks. Changing what it does for all of them to serve one
command is a much larger change than the one asked for, so the index arrives as an **optional
parameter** that only the two message handlers pass: every other call site resolves byte-identically.
The only shared-surface change is the wording of the existing ambiguity error, which now mentions
where the flag exists.

## Decision

- `--variant <i>` (`src/cli/commands/message.ts`) is valid **only** with `--task seq:<N>`. A UUID
  already names one member, and the worktree's own task is not a group address — either one plus the
  flag is a confused command, so it is a usage error rather than a filter applied silently.
- The index is a **plain filter, always applied**, even when the seq is already unambiguous. One rule,
  and it makes an address emitted while the siblings were alive keep working after they are dropped:
  `variantIndex` is permanent, the collision that minted it is not (that is the earlier record's whole
  finding). The alternative — "error, seq:N is not a variant group" — would break exactly that case.
- An index nobody carries throws `VariantNotFoundError`, naming the live indices, or saying the seq is
  not a variant group at all. Across projects that error is a near miss, not a verdict: it is kept and
  raised only if no board matched, because seq collisions between boards are routine.
- `agentReplyCommand` (`src/shared/agent-message-envelope.ts`) emits
  `--task seq:<N> --variant <i>` when `seqShared` and an index exists; a shared seq with no index still
  falls back to the id. `seqIsShared` stays the gate — the `variantIndex != null` rule is not revived.
  `<from-task>` keeps the id, since it is an address and cannot carry a flag.

## Risks

- The flag exists on one command only, so an agent that learns it from `dev3 message --help` may try it
  on `task show`. That fails as an unknown flag, loudly.
- A legacy queued message (no `seqShared`) is still treated pessimistically as shared, but now gets the
  readable `seq:<N> --variant <i>` instead of a UUID. If the seq was in fact never shared, the flag
  still resolves — the filter matches the lone task's own index.

## Alternatives considered

- **Make `--variant` a no-op on a non-shared seq.** Silently ignoring a flag the caller typed hides a
  typo; filtering surfaces it.
- **One `--task` contract across every CLI command.** Explicitly rejected by Arseny.
- **A group-aware `seq:<N>-<i>` ref form.** Would change `findTaskByRef` for every caller — the exact
  shared-resolver change this scope forbids.
