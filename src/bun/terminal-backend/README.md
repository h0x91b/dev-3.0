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
| `capture.ts` | Read-only pane capture: the result shape plus ALL of its pure shaping — sanitizing, bounding, freshness, identity drift. Both adapters share it so their answers cannot drift. |
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

## Read-only pane capture

`captureView(sessionId, viewId, request?)` is the backend-neutral replacement for
`tmux capture-pane`: one bounded textual view of ONE named pane. It never
focuses, writes, resizes, moves writer ownership, or needs the pane's agent to
cooperate — tmux asks the server for the pane's rows, native reads the host's
already-published parser snapshot off disk.

- **`viewId` is required.** A capture is never aimed by focus. Get the pane list
  from `describeSession` first.
- **Every outcome is a result, never a `null` or a throw.** `captured`,
  `session-absent`, `view-absent`, `not-enabled`, `unavailable`, `unreadable`,
  `replaced`. Identity and `readAt` are on all of them; only `captured` carries
  content, so reading text off a miss does not type-check. A pane that genuinely
  shows nothing is a `captured` result with empty arrays.
- **`readAt`, `sourceUpdatedAt`, `lastChangeAgeMs`, `freshness`.** No staleness is
  ever inferred from age: `lastChangeAgeMs` is data, and `freshness` is `current`
  only for a backend that reads the pane itself (tmux). A producer that publishes on
  change offers no heartbeat, so its freshness is honestly `unknown` — a quiet pane
  is not a stale one.
- **Nothing is mutated.** Reads use a non-reconciling inspection, and every
  outcome — miss included — is bracketed by two identity observations, so a pane
  replaced mid-read reports `replaced` rather than the miss it would have been.
- **Physical rows, not logical lines.** Nothing reflows or unwraps.
- **Fixed order of loss:** history beyond the request (oldest first) → history
  that does not fit the byte budget (oldest first) → the viewport's top rows, and
  never without a `viewport-truncated` issue. Whole rows only, UTF-8 bytes.
- **Plain text only.** Every escape sequence and control byte is stripped at the
  seam. History is off by default. No pid, cwd, command, or environment.

**Two native producer surfaces, one consumer.** A host's `captureMode`
(`none | semantic | compact | semantic-and-compact`) decides which artifacts it
publishes, and `capabilities.capture` in its record advertises them as an
independent list: `semantic-snapshot-v1` (the per-cell `parser-state.json`, which
is also the reconnect contract) and `plain-text-capture-v1` (the compact
`capture.json` — rows, health, producer identity). The seam reduces both to one
observation, a conformance test asserts they answer identically, and the two
persist sinks are independent so compact can never disable semantic. The compact
surface exists because publishing the per-cell one on a busy pane costs orders of
magnitude more bytes; `bun run test:capture-cost-e2e` measures it.

**Native reports `not-enabled` in production today** — production runs `none`, so
no surface is advertised. The verdict comes from the host's own record, never from
a timer, so it is correct on the first read. The real-host proof (`bun run test:native-capture-e2e`) covers a
parser-enabled pane and a parser-less one, and
`bun run test:capture-cost-e2e` measures what turning the parser on would cost.
See `decisions/202-*`.

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
- **Capture depth** — tmux offers ~3000 rows of history, native ~200 (the parser
  snapshot's own cap). Reported through `historyLinesAvailable` /
  `historyLinesOmitted` rather than equalised.
- **Capture gaps** — native can prove dropped output and parser health; tmux keeps
  no such account and returns `gaps` as unknown-with-reason, never a zero.
- **Pane-set epoch** — native has a coordinator generation; tmux publishes none,
  so its `epoch` is unknown rather than invented.

## Tests

```bash
bun run test                     # contract conformance (both adapters) + capture shaping + port + isolation
bun run test:full                # + tmux-backend.live-e2e against a real tmux server
bun run test:native-capture-e2e  # capture against a REAL native host (parser on in the test only)
bun run test:capture-cost-e2e    # incremental parser cost: off vs per-cell vs compact, 1/4/6 real panes
```

`__tests__/contract-conformance.test.ts` is ONE suite run against BOTH adapters:
the common single-view lifecycle, reconnect identity, idempotent cleanup, dead
views, and the failure taxonomy. The tmux live e2e proves the actual tmux grammar
the in-memory world cannot (literal input bytes, `resize-window` on a detached
session, pane-id stability across controllers).
