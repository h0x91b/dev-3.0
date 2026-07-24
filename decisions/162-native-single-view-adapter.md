# 162 — Native single-view terminal adapter (integration tracer)

## Context

Seq 1254 (parent 1141, tmux-removal roadmap) is the first integration step after
technical feasibility reached 100%. The merged native primitives (detached Bun
PTY host, persistent registry + protocol v1, live Ghostty parsing, bounded
snapshots, multi-client ownership, crash/restart recovery, stream resync) each
proved a slice in isolation. This step composes them into ONE single-view
lifecycle and proves they work together by driving the existing backend-neutral
parity corpus (MIG-001) against native — before any product backend contract or
user-visible opt-in (MIG-002+).

## Decision

A new module `src/bun/native-terminal-adapter/` (`adapter.ts` +
`view-reconstruction.ts` + `stream-resync.ts` + `native-runner.ts` +
`errors.ts` + `scenario-partition.ts`). `NativeSingleViewAdapter` satisfies the
test-only `ParityRunner` shape **structurally** — production code never imports
`terminal-parity` (a conformance test locks the shape; the isolation test guards
the decoupling), so the adapter stays a self-contained composition. It maps
create/presence/list/active/input/capture/cleanup/reconnect onto
`registry.start/stop`, `readRecord` + `classifyOwnership`, the attach client, and
`readParserState`. `splitView` and second-view `focusView` raise a typed
`MultiViewUnsupportedError`; single-view `killView` == `cleanupSession`.

Capture and reconnect reconstruct from the host's **bounded parser-state
snapshot** (started with `liveParser: true`), rendered to text, with the
sequencing rule's monotonic-watermark half so a capture never rewinds and reads
exactly one snapshot (no loop). The full decision-161 gap→one-snapshot resync
rule is re-implemented self-contained in `stream-resync.ts` (never importing the
removable `prototypes/` spike) and unit-tested against
drop/duplicate/out-of-order/reconnect/overflow.

Parity runs as a standalone `bun` E2E (`test:native-parity-e2e`) reusing the
shared `LIVE_CHECKS`/`PURE_CHECKS`, wired into the existing path-gated
`Packaged Bun runtime` workflow (Windows/macOS/Ubuntu, Bun 1.3.14). No new
always-on all-PR matrix.

## Investigation

Local POSIX run (macOS, Bun 1.3.14): all 10 single-view live scenarios + 2 pure +
the native lifecycle smoke (create/input/capture, fresh-controller reconnect,
owned-tree cleanup + idempotent retry) pass with `ALL CHECKS PASSED`; the
existing tmux parity corpus + live-e2e (31 tests) stay green; `bun run test`
(mainview 2925 / bun 3221 / cli 600) and `bun run lint` clean. The E2E is
platform-aware: on native Windows it runs the pure scenarios + the lifecycle
smoke on a real Windows shell (the POSIX-shell shared checks are logged as n/a). The two registry/parity isolation
tests were widened to exempt the adapter as a SANCTIONED non-production consumer;
the adapter's own isolation test proves it has no product callers, so the registry
stays out of the app/CLI graph transitively.

## Risks

- A capture reads a debounced snapshot (host persists ~250ms), so it can lag live
  output; the corpus checks poll, and the harness widens the snapshot scrollback
  cap so a burst fits. Acceptable for a tracer; the renderer attach path will use
  live client output, not this poll.
- Multi-view scenarios (`split`/`focus`/`capture.dead-view`/`cleanup.removes-session`)
  are deferred because their shared checks open a second view; their single-view
  slices are covered by sibling checks. Recorded in `scenario-partition.ts` and
  enforced by a coverage test so nothing is silently skipped.

## Alternatives considered

- **Client-side Ghostty core fed by the host's journal replay** (byte-exact, full
  scrollback) — rejected as the primary path: it leans on the journal rather than
  the named bounded snapshot and adds a second WASM parser in the adapter.
- **A bounded VT reducer (GridTerminal shape) with scrollback** — rejected:
  re-implements Ghostty at lower fidelity when the host already parses.
- **Running the multi-view scenarios by implementing split now** — rejected as
  out of scope (LAY-003/LAY-004); this step is the single-view tracer only.
