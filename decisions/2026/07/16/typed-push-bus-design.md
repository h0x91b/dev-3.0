# 136. Typed push bus for bun → renderer events (design)

## Context

Every server-initiated update crosses an untyped `window` CustomEvent bus: `pushMessage("taskUpdated")` → `pushMessageHandlers` in `src/mainview/rpc.ts` → `window.dispatchEvent(new CustomEvent("rpc:taskUpdated"))` → ~28 `window.addEventListener` registrations in `App.tsx` + ~17 component-level listeners. Event names and payload shapes are string literals matched at runtime (~131 sites, zero compile-time safety); `(e as CustomEvent).detail` is `any`. The push message declarations are split across two schema maps (`bun.messages` and `webview.messages` in `src/shared/types.ts`) and `pushMessageHandlers` is their hand-maintained union.

## Investigation

The fragility is not theoretical — auditing the wiring found live instances of exactly this bug class:

- `taskRemoved` is declared in the schema and sent by bun (`task-lifecycle.ts`), `App.tsx` listens for `rpc:taskRemoved`, but `pushMessageHandlers` has no `taskRemoved` entry → the push is silently dropped on **both** transports (a consumed todo task stays on the board until reload).
- `openAddProjectModal` — same: sent (`index.ts` menu action), listened for, no handler → dead menu item.
- `cliShowImage` / `cliShowArtifact` are sent and handled but never declared in the schema at all.

These bugs are tracked in a separate bugfix task and must not wait for the bus.

## Decision

Build one deep module owning the push-event namespace end-to-end (grilled with the user 2026-07-16; all points below are confirmed decisions):

1. **Single source of truth**: a named `PushMessages` interface in `src/shared/types.ts`; both `AppRPCSchema` message branches reference it (or subsets of it). The bus and both transports derive from it — no hand-maintained union.
2. **Bus owns the whole namespace**, including renderer-local transport events (`authFailed`, RPC connection status) — one place answers "what events exist and what do they carry". Server pushes and transport events stay distinct types within the module.
3. **API**: `usePush(name, handler)` React hook (auto-cleanup, fresh handler via ref) for components; `onPush(name, handler) => unsubscribe` for non-React consumers (e.g. `menuRouter.ts`). Payload type inferred from the event name.
4. **Own emitter, no `window`**: `Map<name, Set<handler>>` inside the module, per-handler try/catch (one failing subscriber must not starve the rest). The stringly `window` CustomEvent bus is deleted entirely. Tests emit via the exported `emitPush(name, payload)` — the same entry point the transports call. Transport-side dispatch is generated from `PushMessages` (exhaustive `Record` enforced by the compiler), so the "declared but never wired" bug class becomes structurally impossible.
5. **Fire-and-forget semantics** — byte-identical to the current CustomEvent behavior. No replay buffer; boot races stay covered by the existing pending-RPC pattern (`consumePendingQuitDialog`, `consumePendingNotificationNav`).
6. **Migration is big-bang**: bus + `rpc.ts` + `App.tsx` + all component listeners + tests in one task/PR. No transitional dual-dispatch, no period with two competing patterns for agents to copy.
7. **Seam protection: convention + docs only** (no source-scanning guard test). AGENTS.md's RPC section must be updated by the implementation task to point at `usePush`/`onPush` as the only way to consume pushes.

This record is the design deliverable; implementation lands in a follow-up task referencing it.

## Risks

- Convention-only enforcement means a future `window.addEventListener("rpc:*")` would be a silently dead listener; the doc update in AGENTS.md is the only mitigation.
- Big-bang PR is wide (~131 sites, 14+ files); mechanical but review-heavy.
- Merging the two schema message maps into `PushMessages` touches the Electrobun `defineRPC` typing on both sides — verify against `vendor-docs/electrobun/` during implementation.

## Alternatives considered

- **Derive the union from `AppRPCSchema` as-is** (no `PushMessages`): fewer edits to types.ts but fragile type gymnastics over two nested maps.
- **CustomEvent kept under the hood** (typed facade over `window`): old tests survive untouched, but the real bus stays global and bypassable.
- **Replay buffer for early pushes**: closes boot races generically but changes semantics (double-handling on remount) with no confirmed case the pending-RPC pattern doesn't already cover.
- **Incremental migration**: lower per-PR risk, but requires dual-dispatch and leaves two patterns in the codebase during the transition.
- **Guard test scanning sources for `rpc:` listeners**: rejected by the user in favor of convention.
