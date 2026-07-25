# 171 — Backend-neutral terminal process/port ownership accounting

## Context

Resource and listening-port accounting (`resource-monitor.ts`, `port-scanner.ts`)
is written against tmux pane PIDs. A native terminal session would therefore be
invisible to it — no CPU/RSS, no ports — which is a safety and observability gap
that must close before native becomes a normal backend (seq 1293, tmux-removal
roadmap). This slice adds the accounting seam only: read-only, no launch path, no
UI/RPC, no poller rewiring.

## Decision

`src/bun/terminal-process-ownership/` — a claim → snapshot seam:

* `contract.ts` — pure vocabulary. A backend produces a `TerminalOwnershipClaim`:
  proved roots plus a **proof**. No proof means an explicit `unavailable` /
  `stale` / `reused` snapshot with a reason; ownership is never inferred from a
  task id or a bare PID, and a verified-but-root-less claim degrades to
  `unavailable` rather than reading as "this session is free".
* `collector.ts` — the adapter over the **existing** scanners
  (`collectProcessInfo`, `collectDescendants`, `aggregateResources`,
  `getLsofOutput` + `parseLsofOutput`). No second monitoring subsystem; this
  module only decides which PIDs those scanners may attribute. An unproved claim
  runs no scanner at all.
* `tmux-source.ts` — the only file here that speaks tmux, via the existing
  pane-PID helpers over the typed client singleton.
* `native-source.ts` — translates the persisted native session record + its
  ownership verdict (POSIX start signature / Windows Job membership).

Two non-obvious choices:

1. **The native source imports nothing from the native session store.** That
   module's isolation test forbids any outside reference to it, so this file
   declares plain input types that are *structurally* compatible with its public
   read APIs — the same "standalone by contract" pattern as
   `native-terminal-diagnostics`. The caller passes the record and verdict
   through; the seam stays out of the store's import graph.
2. **`coverage` flags instead of an implied zero.** `ps` / `lsof` do not exist on
   Windows, where Job membership proves identity but cannot enumerate a tree. The
   snapshot then reports `descendants/resources/ports: false` — "not measured" —
   while ownership still verifies. Flattening that to an empty result would read
   as a free session.

## Risks

* Structural compatibility with the record/verdict shapes is not type-checked
  (it cannot be, given the isolation rule). A future rename inside the store
  would only surface when the caller is wired up in the launch slice.
* Windows keeps no descendant/port accounting until a Windows process
  enumeration primitive exists. That is explicit in the snapshot, not silent.

## Alternatives considered

* **Extend the tmux pollers with native branches.** Rejected: it would couple
  accounting to the launch path and put two backends' assumptions into one
  poller, which is what this seam exists to avoid.
* **Import the session store directly from the native source.** Rejected: breaks
  its isolation guard and drags the whole store into the product import graph
  before the launch slice (seq 1292) is ready.
* **Real-process coverage as a vitest test.** Not possible: `src/bun`'s vitest
  setup stubs `Bun.spawn`, so a piped child never resolves. The real-scanner proof
  runs under bun as `__tests__/ownership.bun-e2e.ts`
  (`bun run test:ownership-e2e`), matching the existing `*.bun-e2e.ts` pattern.
