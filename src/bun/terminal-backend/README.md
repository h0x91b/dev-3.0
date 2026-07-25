# Product terminal-backend seam (MIG-002, seq 1280)

One **backend-neutral product contract** for everything dev3 needs from a
terminal backend, plus **two real adapters** behind it: the current tmux
implementation and the already-merged native single-view lifecycle.

This task creates the **seam only**. tmux remains the production backend; there
is no selector, feature flag, fallback, migration, session adoption, or persisted
backend identity, and **no production code imports this module** (guarded by
`__tests__/isolation.test.ts`).

## Files

| File | Role |
|------|------|
| `contract.ts` | The vocabulary: session/view lifecycle, attach, input, resize, capture, focus, split, close, cleanup. Ids are opaque product strings; one portable session-id rule for both backends. |
| `errors.ts` | `TerminalBackendError` with a discriminated `code` — the whole failure taxonomy of the seam. Backend errors are wrapped in `backend-failure` with the original on `cause`. |
| `tmux-port.ts` | The **only** file that speaks tmux: names, `%pane` ids, `-F` formats, sockets, and argv stay behind this narrow port over the typed `TmuxClient`. |
| `tmux-backend.ts` | Product logic for the tmux backend: validation, presence/membership checks, focus, error mapping. |
| `native-backend.ts` | Wraps `NativeSingleViewAdapter`. Imports nothing from the native registry, so the seam does not widen that module's reach. |
| `index.ts` | The barrel — contract + errors + the two backend classes, nothing backend-shaped. |

## Where the contract comes from

Derived from the frozen parity corpus (`../terminal-parity/corpus.ts`) **and**
actual product needs — it is not a promotion of the test-only `ParityRunner`,
which has no attach handle, no resize, no error taxonomy, and a test-shaped
`dispose`. Concretely:

- **`TerminalAttachment`** — the product's live write/resize/read binding to one
  view, obtainable from a *fresh* controller (reconnect) with identical ids.
- **Resize** — a first-class product operation the corpus only records as an
  intentional-difference note.
- **Typed failures** instead of "a catchable error or an empty result".
- **`describeSession` returning `null`** — presence, views, and focus in one read
  instead of four separate probes.
- **`dispose()` never kills sessions** — sessions are persistent; only
  `cleanupSession` tears one down.

## Backend differences (deliberate, not negotiated)

There is **no capability negotiation**: a caller holds one backend and an
unsupported product operation fails with the typed `unsupported` code.

- **Native multi-view** (`splitView`, focusing a second view) → `unsupported`
  until LAY-003/LAY-004 lands.
- **Resize scope** — tmux geometry lives on the window, so a resize applies to
  the session's layout; native resizes the view's PTY. Recorded in the corpus's
  `INTENTIONAL_DIFFERENCES`.
- **Ownership** — a native record owned by another app instance reads as absent
  (`describeSession` → `null`), so this seam never touches a session it does not
  own.

## Tests

```bash
bun run test        # contract conformance (both adapters, in-memory worlds) + port + isolation
bun run test:full   # + tmux-backend.live-e2e against a real tmux server
```

`__tests__/contract-conformance.test.ts` is ONE suite run against BOTH adapters:
the common single-view lifecycle, reconnect identity, idempotent cleanup, dead
views, and the failure taxonomy. The tmux live e2e proves the actual tmux grammar
the in-memory world cannot (literal input bytes, `resize-window` on a detached
session, pane-id stability across controllers).
