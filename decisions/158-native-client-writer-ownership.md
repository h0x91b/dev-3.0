# 158 — Native client writer ownership stays host-local

## Context

One native terminal host must fan output and reconstructable state to several
local clients without duplicating PTY input or letting independent viewports
fight over the shared PTY dimensions. The existing loopback token admits a
client to the local session; writer ownership is coordination, not authorization.

## Investigation

The host already serializes WebSocket callbacks on one event loop and broadcasts
each PTY output chunk to every attached socket. The missing seam was a small
compare-and-set over connection identity; persisted leases, account roles, or a
new protocol version would add failure modes without making that transition safer.

## Decision

`writer-ownership.ts` keeps one ephemeral writer pointer plus the authenticated
client set: the first client is writer, later clients are observers; while any
observer remains, writer release/disconnect leaves the slot vacant until one
atomic `ownership{action:"claim"}` wins, and only that socket may input or resize.

The additive protocol-v1 reply reports each connection's role and writer
presence; `release`, claim conflicts, observer input, and observer resize use the
existing compact response/error shapes; no project, task, or session record
field stores the lease, so a new host always starts clean.

Each accepted hello queues the host's authoritative in-memory journal tail in
the same synchronous turn before that socket joins live fan-out; the client
buffers those bounded binary frames until its output listener attaches, giving
each connection one replay→live boundary with no disk-flush gap or duplication.

## Risks

A client must explicitly claim after the writer disappears while observers are
still attached; this deliberate vacant state favors deterministic ownership over
surprising auto-focus. An older v1 client ignores the additive role field and
keeps its original behavior as a sole attachment, while an older host ignores
the new ownership request rather than misinterpreting it; neither case requires
capability negotiation or a breaking protocol-v2 reinterpretation.

## Alternatives considered

Automatic observer promotion was rejected because disconnect order would choose
a hidden writer and could let a background viewport resize the PTY. Arbitrating
by the smallest viewport was rejected because this task defines input/focus
ownership, not layout policy; persisted leases and protocol v2 were unnecessary.
Client-side disk replay was rejected because its debounced read races live bytes
around attach, causing a missing or duplicated reconstruction boundary.
