# 161 — Terminal stream resync sequencing rule (spike)

## Context

Seq 1249 (parent 1141, tmux-removal roadmap, ticket STATE-006) needed proof that
a reconnecting or slow terminal client can detect missed output and recover from
a fresh snapshot instead of rendering corrupt state — without building an
event-sourcing framework or touching the frozen native-session protocol
(decision 154), writer ownership (decision 158), the renderer, or a real PTY.

## Decision

A pure spike in `src/bun/prototypes/stream-resync/` (isolated like the sibling
terminal-state spike). The minimal model: the writer numbers `delta` frames with
a strictly increasing `seq` and, on request, emits one `snapshot{baseSeq, state}`
where `state` is an opaque, serializable backend blob. The client rule
(`client.ts`): apply `seq == lastSeq+1`; ignore `seq <= lastSeq` (never resync);
on `seq > lastSeq+1` stop, buffer, and request ONE snapshot; on snapshot restore
state, set `lastSeq = baseSeq`, drain the buffer, resume. `captureSnapshot()` is
read-only, so resync never changes writer ownership or PTY size.

Convergence rests on one invariant: `baseSeq` (host seq at capture) `>=` every
buffered delta, so buffered frames drop as stale in a single drain — no loops. A
pending-request flag stops duplicate/stale bursts from re-requesting; a stale
snapshot (`baseSeq < lastSeq`) is ignored so it cannot rewind. The resync buffer
is bounded (frames + bytes); overflow fails honestly to `FAILED` rather than
buffering unbounded or rendering garbage.

## Investigation

Backend-neutrality is proven concretely by running the identical sequencer /
transport / client against two reducers (`terminal-model.ts`): `GridTerminal`
(compact bounded semantic snapshot incl. in-progress UTF-8/CSI parser state, so
restore is lossless at any byte boundary) and `ByteJournalTerminal` (byte-exact
op journal). A fake transport injects drop, duplicate, out-of-order, and
disconnect/reconnect; every case reconstructs to a ground-truth reducer fed the
uninterrupted stream (`__tests__/stream-resync.test.ts`, 28 tests).

## Risks

Spike-only, out of the production import graph (`isolation.test.ts`), no WASM, no
stored state — zero effect on existing tmux terminal flows. Synchronous snapshot
delivery in the harness is a test simplification, not a transport model.

## Alternatives considered

A client-side reorder buffer (hold a future frame awaiting the missing one) was
rejected as scope creep over the required "gap → resync" rule. Adopting the
terminal-state event-journal as the production snapshot was rejected as unbounded;
a bounded native export (the `GridTerminal` shape) is the recommended follow-up.
Per-frame checksums / compression / replay history are explicitly out of scope.
