# A resize ack does not imply the session record is on disk

## Context

The Windows release gate `Product native task-terminal E2E` failed on tag v1.42.1
(sha `d91e5d2dd`, run `31248826195` attempt 1, job `93081796448`) with a single check:

```
FAIL - geometry follows the lease BACK to the first process (118x36)
```

Its siblings passed: handing the writer lease to a peer process, taking it back, and the
shell surviving both. A parallel run on the same sha two seconds later was green, so no diff
was implicated.

## Investigation

The check is a conjunction: a local viewer must be told the new grid, **and** the session
record on disk must already carry it. Which conjunct failed is decidable from the job log:

```
08:42:18.3228  ok   - the first process takes control back once the peer lets go
08:42:18.3547  FAIL - geometry follows the lease BACK to the first process (118x36)
```

32 ms apart. `awaitHeader` (the test's own helper) can only return `false` by exhausting its
timeout, which is 8000 ms here — so the viewer half was **true**. Geometry did follow the
lease back. The record on disk was the failing half.

`host.ts`'s resize branch applies the resize, fires `void persist().catch(...)` — fire and
forget, through `publishOwned` → `withOwnedSessionState` (a cross-process lock) → mkdir +
write temp + rename — and sends the ack **first**. So every in-band event outruns the file.

Measured with a probe booting a real host and client, `resizeAwaited` then `readRecord`
immediately, on an idle Mac:

| Writes queued ahead | Stale right after the ack | Catch-up lag |
|---|---|---|
| 0 | 20 / 20 | 1.3 – 2.9 ms |
| 1 | 20 / 20 | 2.5 – 6.5 ms, one outlier **47.3 ms** |
| 3 | 20 / 20 | 4.8 – 7.5 ms |

60 of 60 samples stale: the property the check assumed is false **100 % of the time, on every
platform**. It passed only because `awaitHeader` polls every 20 ms and accidentally donated
~20 ms of slack. A loaded Windows runner eats that slack.

The product does **not** share the assumption: `MultiPaneCoordinator.resizePane`
(`src/bun/native-terminal-multipane/coordinator.ts`) polls the record with a 5 s deadline and
its docblock says why. Every other record reader wants pids, ports, command or liveness — all
facts `registry.start()` already waits for.

## Decision

Fix the test, not the product. `awaitRecord()` in
`src/bun/__tests__/native-task-terminal.bun-e2e.ts` waits for the record to satisfy a
predicate and returns the last record seen, so a failure prints what the file actually held.
Applied at all **three** reads of record geometry in that file — the failing one and two that
were only luckier (separated by a shell round trip and by 20 s) — because one false
assumption in three places is one defect, and a half-migration would bring the next Windows
run back for the survivors.

Not chosen: awaiting `persist()` before the ack. It would put a locked file write on the
critical path of every resize, so dragging a window would serialize on the filesystem — a
real cost for a property nothing consumes.

## Risks

The check now tolerates a persistence lag of up to 5 s. What it stops asserting is
"persistence is synchronous with the ack", which was never true. Both halves were mutation
tested against product-side breakage:

| Mutation (product code) | Result |
|---|---|
| `broadcastNativeRoles` dropped from the resize-ack continuation in `pty-server.ts` | `FAIL - … (second viewer told: false, record: 118x36)` |
| host acks the resize but never adopts or persists it | `FAIL - … (second viewer told: false, record: 132x43)` |

## Alternatives considered

- **Await `persist()` before the ack** — see above.
- **A "record settled" signal in the host protocol** — a permanent protocol surface added for
  a test's benefit.
