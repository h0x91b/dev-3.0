# Product terminal-backend seam (MIG-002, seq 1280)

One **backend-neutral product contract** for everything dev3 needs from a
terminal backend, plus **two real adapters** behind it: the current tmux
implementation and the already-merged native single-view lifecycle.

The seam itself still holds no selector, feature flag, fallback, migration, or
session adoption. Since seq 1292 it has exactly ONE production caller —
`../task-terminal-backend.ts`, which decodes a task's persisted
`terminalBackend` identity and returns the matching adapter. Everything else must
go through that resolver (guarded by `__tests__/isolation.test.ts`), so backend
branches cannot spread through the app. tmux remains the default for every task
without an explicit `native` marker. See `decisions/171-*`.

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
- **`launch` (executable + argv)** — the native backend spawns a process itself, so
  a command string would have to be re-split by guesswork. `launch` wins over
  `command`; tmux quotes it back into one shell string, native passes it through.
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
