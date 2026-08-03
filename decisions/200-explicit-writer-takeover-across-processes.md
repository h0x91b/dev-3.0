# 200 — Explicit `Take control` transfers the writer lease across app processes

## Context

Decision 158 gives a native pane's host exactly one writer lease, and `claim` may take
only a vacant slot. Decision 191 then taught the app to report a refusal rather than move
a lease it does not own. Neither left any action able to move a LIVE lease. Several dev3
processes share one `~/.dev3.0` (022), so a viewer outside the launching process was
permanently read-only.

## Investigation

`WriterOwnership.request(client, "claim")` returns `writer-active` whenever a writer
exists, and the explicit gesture sent exactly that. Reproduced in
`~/.dev3.0/logs/2026/08/2026-08-03.log` lines 30978–31138: pid 74178 attaches as an
observer, then fifteen refusals while pid 80386 holds the lease.

## Decision

A third ownership action, `takeover` (`writer-ownership.ts`), swaps the writer pointer in
one synchronous turn on the host's event loop, while `claim` keeps its non-stealing
semantics so attach and `ensureWriter` are untouched. The contract is
**last-explicit-takeover-wins**: the host serializes takeovers, so a gesture cannot lose to
a rival and an expected-owner guard would only make the button refuse a click the user
meant. Supporting invariants live as comments on the code that enforces them — one
broadcast per transition with the winner confirmed last, correlation by
`(id, kind, connection)` from a single allocator with `id: 0` alone unsolicited, canonical
geometry written only from an authoritative ack, and an ambiguous request compensated by
rebinding rather than guessed at. Only an announced-capability-absent host answering
`writer-active` yields `host-too-old`; every other failure is `transfer-failed`.

## Risks

A displaced writer loses the PTY mid-keystroke — intended, explicit, reversible. Frame
arrival order across sockets is not guaranteed, so only host-side enforcement is
load-bearing; a takeover demotion is told apart from a vacancy by `writerAttached`. The
generation compare is reachable and load-bearing: a stale writer that takes over passes
the role check, so a resize it sends before processing the ownership reply still carries
the old generation and must be refused on that. A narrow observer clips rather than
letterboxes.

## Alternatives considered

Automatic observer promotion (rejected by 158) and a host-side inject endpoint (breaks the
one-writer invariant). Peer-mediated release over the CLI socket needs a cooperative owner
and leaves a window for a third claimant. A generation/ack rejection protocol buys a
refusal nobody wants, since host enforcement already prevents two writers. One owner
process per task is cleanest long-term but far beyond this blast radius (see 191).
