# Native single-view terminal adapter (seq 1254)

The first integration step of the tmux-removal roadmap (parent seq 1141) after
technical feasibility hit 100%. It **composes** the already-merged native
primitives — the persistent session registry, the attach client, the versioned
record, passive ownership classification, and the host's bounded parser-state
snapshot — into ONE cohesive **single-view** terminal lifecycle, and proves the
pieces work together by driving the existing **backend-neutral parity corpus**
against them.

This is production-quality composition with **no product callers yet**
(`__tests__/isolation.test.ts`). It is NOT the product `TerminalBackend` seam and
introduces none of: a backend contract, backend selection, a persisted backend
marker, a feature flag, migration, adoption, fallback, or dual ownership. It
never inspects, attaches to, stops, or modifies any tmux session, and it writes
only under a test-controlled temporary `~/.dev3.0/native-sessions/` namespace.

## The single-view lifecycle

`NativeSingleViewAdapter` satisfies the backend-neutral `ParityRunner` shape
(`../terminal-parity/runner.ts`) **structurally** — production code never imports
the test-only corpus (a test proves conformance and the decoupling):

| ParityRunner op | Native mapping |
|---|---|
| `createSession` | `registry.start(id, { launch, liveParser })`; first view id = `record.paneId` |
| `isSessionPresent` / `listViews` / `activeViewId` | `readRecord` + passive `classifyOwnership` (owned ⇒ one active view) |
| `sendInput` | attach a writer client, write `text + CR` to the PTY |
| `capture` | render the host's BOUNDED parser-state snapshot to text (see below) |
| `cleanupSession` / `killView` | `registry.stop(id)` — token-matched, owned-tree only |
| `splitView` / second-view `focusView` | typed `MultiViewUnsupportedError` (deferred, see below) |
| `reconnect` | a fresh adapter on the same on-disk namespace (models a new process) |

A fresh controller rediscovers the same host, shell, session, logical view, and
captured state from the on-disk record + token + snapshot alone — no duplicate
process is spawned. Missing sessions and dead views produce typed, catchable
results (`NativeSessionNotFoundError` / `NativeViewGoneError`) or the documented
empty result — never an uncaught crash.

## Capture / reconnect: bounded snapshot + sequence-resync

Reconstruction uses the host's **bounded** parser-state snapshot (the live
Ghostty screen + capped scrollback the host already persists), never an unbounded
journal replay:

- `MonotonicSnapshotView` (`view-reconstruction.ts`) reads that snapshot and
  applies the sequencing rule's monotonic half: a snapshot whose `watermarkSeq`
  is at least the last applied is accepted and cached; a stale snapshot is
  ignored so a capture never rewinds. Exactly one snapshot is read per capture —
  there is no repeated resync loop.
- `StreamResyncReader` (`stream-resync.ts`) is the full proven rule (decision
  161), composed self-contained (never importing the removable `prototypes/`
  spike): apply in-order deltas, ignore duplicates/stale, and on a gap recover
  from ONE bounded snapshot — bounded buffer, no loop, honest `failed` on
  overflow. Unit-tested against dropped / duplicate / out-of-order / reconnect /
  overflow cases.

## Scenario partition (`scenario-partition.ts`)

Every corpus scenario is accounted for (a unit test fails if a new one is not):

- **Single-view live (run now):** create (cwd/env + stable id), attach
  (current+subsequent output, missing-session), input, capture (content+order),
  reconnect, high-output, exit, cleanup-retry-idempotent.
- **Deferred to LAY-003/LAY-004 (multi-view):** `split.adds-second-view`,
  `focus.exactly-one-active-view`, `capture.dead-view-is-clean`,
  `cleanup.removes-session`. Each shared check opens a SECOND view via
  `splitView`. Their single-view slices are still covered by
  `cleanup.retry-is-idempotent`, `exit.process-exit-ends-view`, and the native
  lifecycle smoke.
- **Pure (backend-neutral, run unchanged):** the two `resize.*` scenarios.
- **Gaps (documented, not driven — same as the tmux runner):**
  `attach.duplicate-attach-does-not-disrupt`, `exit.status-code-propagates`,
  `cleanup.reaps-owned-process-tree` (the shared check needs a spawned tree; the
  adapter proves owned-tree teardown in the native lifecycle smoke instead).

The E2E's `nativeLifecycleSmoke` runs on both platforms with the real
per-platform shell (POSIX `sh` / Windows PowerShell): create → input → snapshot
capture → fresh-controller reconnect → owned-tree cleanup + idempotent retry. It
is the native Windows coverage for the adapter, since the shared corpus checks
are authored in POSIX shell.

## Gaps before MIG-002

MIG-002 (introduce the product backend contract) still needs, outside this
tracer: the multi-view layout binding (LAY-003/LAY-004) so split/focus and
dead-view semantics run through the shared corpus; a `TerminalBackend` seam with
backend identity as backward-compatible data (MIG-003); opt-in native creation
(MIG-004) and safe rollback (MIG-005); and exit-status propagation over the
attach path (`exit.status-code-propagates`). None of those are started here — this
step only proves the merged primitives compose into one working lifecycle.

## Run

```bash
bun run test                 # unit tests (mapping, resync rule, rendering, isolation, partition)
bun run test:native-parity-e2e   # real-runtime single-view parity vs native (POSIX / Bun >= 1.3.14)
```

The real-runtime E2E runs as a standalone `bun` script (vitest stubs the Bun
global, so a live `Bun.Terminal` cannot run there) and is wired into the
path-gated `Packaged Bun runtime` CI on Windows, macOS, and Ubuntu with the
pinned Bun 1.3.14. See [decision 162](../../../decisions/162-native-single-view-adapter.md).
