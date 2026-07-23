# Stream-resync spike

A narrow, self-contained proof of one **backend-neutral stream sequencing rule**:
a reconnecting or slow terminal client detects missed output and recovers from a
single fresh snapshot instead of rendering corrupt state. Groundwork for the
tmux-removal roadmap (parent seq 1141, ticket STATE-006).

This is a spike, NOT production terminal integration and NOT a `TerminalBackend`
abstraction. It is imported by nothing in the app or CLI graph (guarded by
`__tests__/isolation.test.ts`), touches no real PTY, shell, socket, renderer, or
native host, and loads no WASM. It consumes fake/recorded terminal bytes only.

## Sequence model (minimal)

The writer owns one monotonic `seq` counter and the authoritative terminal state.
Two frame kinds, nothing more — deliberately not a generic event-sourcing engine:

```text
delta    { v, type:"delta",    seq,     op }     seq strictly increasing, 1-based
snapshot { v, type:"snapshot", baseSeq, state }  full state as of baseSeq
op       = output(bytes) | resize(cols, rows)
```

- `state` is an **opaque, self-contained, serializable** blob produced by the
  terminal backend. The sequencing layer never inspects it.
- `captureSnapshot()` is **read-only** — it reads `state` at the current `seq`.
  It never changes writer ownership or PTY size, so any number of slow observers
  can resync without disturbing the writer or the shared dimensions.

## Client rule

The client applies deltas strictly in order and reacts to the seq relationship:

```text
seq == lastSeq + 1  → apply, lastSeq = seq
seq <= lastSeq       → duplicate / stale → ignore (NEVER resync)
seq  > lastSeq + 1   → GAP → stop applying, buffer, request ONE snapshot
snapshot(baseSeq)    → restore state, lastSeq = baseSeq, drain buffer, resume
```

### State machine

```text
                 start() / reconnect            gap (seq > lastSeq+1)
        ┌──────────────────────────┐   ┌──────────────────────────────┐
        │                          ▼   │                              ▼
   ┌─────────┐   snapshot     ┌─────────┐   seq == lastSeq+1     ┌─────────┐
   │ SYNCING │───────────────▶│  LIVE   │───────────────────────▶│  LIVE   │
   │ (buffer │  restore+drain │ (apply  │   seq <= lastSeq: drop │         │
   │  deltas)│                │  live)  │◀───────────────────────┘         │
   └─────────┘                └─────────┘   (duplicate/stale, no resync)
        │                          
        │ buffer exceeds bound     
        ▼                          
   ┌─────────┐                     
   │ FAILED  │  honest stop; later frames ignored, no corrupt render
   └─────────┘                     
```

### Why it converges (no resync loops)

- One outstanding snapshot request is guarded by a `pendingSnapshot` flag, so a
  burst of gapped/duplicate/stale deltas triggers **at most one** request.
- The snapshot's `baseSeq` is the host's seq at capture, which is `>=` every
  delta the client could have buffered before requesting it. On restore, all
  buffered deltas are `<= baseSeq` and drop as stale — the queue drains in one
  pass and live output resumes ordered.
- A stale snapshot (`baseSeq < lastSeq`, e.g. a late duplicate) is ignored, so it
  can never rewind a recovered client.

## Bounded resync

The buffer held during `SYNCING` is bounded by both frame count and byte size.
Overflowing it moves the client to `FAILED` with an explicit reason instead of
buffering without limit or rendering a corrupt screen — fail honestly, then let a
higher layer decide (drop the viewport, re-attach fresh, etc.).

## Backend-neutral proof

The rule is proven against **two different terminal reducers** through the exact
same sequencer, transport, and client, showing it depends on none of them:

| Sink | Snapshot | Proves |
|---|---|---|
| `GridTerminal` | compact, **bounded** (cells + cursor + decoder/parser continuation) | a real semantic screen reconstructs after every recovery case, at any byte boundary |
| `ByteJournalTerminal` | full ordered op journal (unbounded, like the terminal-state event-journal spike) | the recovered logical byte stream is **byte-exact** to the uninterrupted one |

Because the recovered stream is byte-identical (journal proof) and the recovered
semantic screen matches ground truth (grid proof), **any** deterministic backend
fed the recovered stream reaches identical state. The renderer's real Ghostty
core (the sibling terminal-state spike) is one such backend via an event journal;
production reconstruction fidelity is already covered there.

`GridTerminal` captures its in-progress UTF-8 and escape-parser state, so a
snapshot restores losslessly even when a multi-byte glyph or CSI sequence is
split across the dropped frame. This is the compact, bounded snapshot shape a
future native export should target (it also addresses the terminal-state spike's
unbounded-journal gap).

## Injected failure cases (all recover to ground truth)

`__tests__/stream-resync.test.ts`, parametrized over both sinks:

- dropped frame → one snapshot → resumed
- duplicate frame → ignored, no resync
- out-of-order frame → gap-resync, late arrival ignored, no loop
- disconnect + reconnect → forced snapshot → resumed
- stale/duplicate storm → no gaps, no extra snapshot requests
- two observers behind on different frames → independent resync; writer id and
  PTY size unchanged
- queue bound exceeded → honest `FAILED`, later frames ignored, no crash

Each case asserts the reconstructed state equals a ground-truth reducer fed the
identical uninterrupted stream.

## Files

| File | Role |
|---|---|
| `protocol.ts` | Frame types, constructors, version gate, queue-cost helper. |
| `sequencer.ts` | Writer: monotonic seq, authoritative sink, read-only snapshot. |
| `client.ts` | Reader: the resync state machine (dedup, bounded buffer, one-snapshot recovery). |
| `terminal-model.ts` | Two backend-neutral `ResyncSink`s: `GridTerminal`, `ByteJournalTerminal`. |
| `fake-transport.ts` | In-memory `FakeLink` with scripted drop/duplicate/hold/disconnect. |
| `harness.ts` | Wires sequencer + ground truth + clients; drives scenarios. |

## Run

```bash
bun run test:stream-resync-spike
```

## If this rule is adopted (production follow-ups, not done here)

This spike deliberately changes no production code. Adopting the rule would need,
outside this prototype:

- Add `seq` to native-session delta (binary output) frames and a `snapshot`
  request/reply to the frozen protocol — a `NATIVE_SESSION_PROTOCOL_VERSION` bump
  handled explicitly per decision 154 (never in-band negotiation).
- Give the host a **bounded** state export (the compact snapshot shape here), not
  the terminal-state event-journal, to serve resync without unbounded memory.
- Wire the client rule into the renderer's terminal attach path, keeping the
  read-only invariant so resync never touches writer ownership (decision 158) or
  PTY size.

## Removal

Delete `src/bun/prototypes/stream-resync/` and the `test:stream-resync-spike`
package script. No daemon, stored state, migration, or production import to undo.
