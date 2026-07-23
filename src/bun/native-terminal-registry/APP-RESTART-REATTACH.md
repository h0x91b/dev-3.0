# App-restart reattach (seq 1247)

Technical-feasibility evidence for the **app-restart slice of HOST-006 / WIN-002**
(seq 1141 tmux removal roadmap). It proves that a live native terminal session
survives full desktop-app process turnover: the app can disappear and a brand-new
app process rediscovers and reattaches to the same live host + shell from the
on-disk registry alone — with **no tmux involved**.

This is a proof, not product integration: no `TerminalBackend`, UI, RPC, settings,
feature flag, or persisted project/task field is added, and the production tmux
path is untouched. It reuses the isolated registry from seq 1214/1236/1237
(decisions [151](../../../decisions/151-native-session-registry.md),
[158](../../../decisions/158-native-client-writer-ownership.md),
[159](../../../decisions/159-native-host-crash-recovery.md)).

## Why a new proof (vs the existing E2Es)

| E2E | What it models | App-restart gap |
|-----|----------------|-----------------|
| `lifecycle.bun-e2e.ts` | one long-lived driver; `discover()` runs **in the same process** that called `start()` | the app process never actually exits before reattach |
| `multi-client.bun-e2e.ts` | `stop()` then `start()` = a **new host** | the host restarts, not the app |
| **`app-restart.bun-e2e.ts` (this)** | **two separate short-lived controller processes**; the host stays the same and alive across the gap | — |

The distinguishing move: the process that starts the session and the process that
reattaches are **different, genuinely disposable OS processes** (asserted via
distinct `controllerPid`s and `!isProcessAlive(controllerPid)` after A exits),
while the detached host PID is unchanged throughout.

## Shape

```
driver (app-restart.bun-e2e.ts)                     detached host (survives everything)
  │  tmpdir registry + tmux PATH-shim sentinel + unrelated guard (sleep 300)
  ├─ spawn ─▶ controller A: start-mark ──┐          ┌─ host + shell spawned unref'd
  │            start(id) · export marker │          │  keeps running after A exits
  │            · echo ROOTPID · detach   │          │
  │◀──── A exits (JSON verdict) ─────────┘          │
  │  assert: host+shell alive · A gone · guard alive│
  ├─ spawn ─▶ controller B: reattach-verify ────────┤  SAME host/shell/session/pane
  │            discover(id) · status() · read marker│  single writer; 2nd client = observer
  │◀──── B exits (JSON verdict) ─────────────────────┘
  ├─ spawn ─▶ controller C: stop  → owned tree dies; guard + sentinel survive
  └─ spawn ─▶ controller: reattach-lost ×3 (missing / dead / reused) → honest lost, no new shell
```

`app-restart-controller.ts` is the disposable app process. Each invocation does one
phase, prints one `__APP_RESTART_JSON__{…}` verdict line on stdout, and exits.

## What each acceptance criterion maps to

- **Two short-lived controllers, A exits without stopping the host** — phase
  `start-mark`; the host is spawned detached + `unref()`'d by the registry, so A's
  exit leaves it running. Driver asserts `isProcessAlive(hostPid && shellPid)` and
  `!isProcessAlive(aControllerPid)`.
- **B (clean process) reattaches to same host/shell/session/pane + state** — phase
  `reattach-verify`; `discover(id)` reconnects from disk alone. Identity is
  cross-checked three ways (A's report ≡ B's `status()` ≡ on-disk `record`), pane id
  is `"<id>:0"`, and preserved state = the `DEV3_NATIVE_STATE` env var + the same
  interactive root PID echoed back after reattach.
- **Deterministic writer lease after restart** — B is the single writer
  (`clientRole:"writer"`, `writerAttached:true`); a concurrent second client is a
  pure observer that receives fanned-out output but whose input **and** resize are
  refused (`conflict`), so no duplicate input path or resize owner survives A's
  departure. (Mechanism: the host clears the writer on socket close —
  `host.ts` → `close(ws)` → `WriterOwnership.detach`.)
- **Explicit stop removes only the owned tree + state** — phase `stop`; owned host
  + shell die, registry state is removed, the unrelated guard and the tmux sentinel
  survive.
- **Stale/missing metadata → honest lost-session, never spawns a replacement** —
  phase `reattach-lost` run three times: missing record (discover throws), stale
  dead record (verdict `dead`), reused PID = the live guard (verdict `reused`). The
  reattach path uses `discover`/`status` only — never `start` — so no shell is
  spawned, the recorded host is never revived, and the reused PID is never signalled
  (guard stays alive; session-dir count is unchanged).
- **Focused macOS/Linux + Windows CI** — `bun run test:native-app-restart-e2e`
  added to the `Packaged Bun runtime` matrix (`windows-latest`, `macos-latest`,
  `ubuntu-latest`, Bun 1.3.14) in `.github/workflows/windows-conpty-package.yml`.

## Commands

```bash
# focused proof (macOS / Linux / native Windows, Bun 1.3.14)
bun run test:native-app-restart-e2e

# import-graph + tmux-sentinel isolation guard
bunx vitest run --config vitest.config.bun.ts \
  src/bun/native-terminal-registry/__tests__/isolation.test.ts
```

## Result (macOS, Bun 1.3.14 — 4 consecutive green runs)

```
  info - platform=darwin bun=1.3.14
  ok   - controller A started the session and planted its shell-state marker
  ok   - the host is a separate detached process, not controller A itself
  ok   - the session record persists on disk after controller A exits
  ok   - host + shell stay ALIVE after controller A's process has exited
  ok   - controller A's process is genuinely gone (full app-process turnover)
  ok   - unrelated guard process is alive after controller A exits
  ok   - controller B reattached, proved single-writer determinism, and read preserved state
  ok   - controller B is a genuinely separate process from controller A
  ok   - controller B reattached to the SAME host PID
  ok   - controller B reattached to the SAME shell PID
  ok   - controller B reattached to the SAME session id
  ok   - controller B reattached to the SAME pane id
  ok   - controller B observed the preserved shell state (env var + root PID)
  ok   - controller B is the single writer after restart (no stale writer lease survived)
  ok   - a concurrent second client after restart is a pure observer
  ok   - no duplicate input path exists — observer input is refused
  ok   - no duplicate resize owner exists — only the reattached writer resizes the PTY
  ok   - host + shell survive controller B's disconnect too
  ok   - explicit stop from a later app instance succeeds
  ok   - stop terminated exactly the owned host + shell tree
  ok   - stop removed the owned registry state
  ok   - stop left the unrelated guard process untouched
  ok   - reattach against MISSING metadata reports an honest lost session
  ok   - missing-metadata reattach fails discovery and reports not-running
  ok   - missing-metadata reattach spawned NO replacement shell or session state
  ok   - reattach against a stale DEAD record reports an honest lost session
  ok   - the dead record is classified dead and not-running
  ok   - the dead reattach neither spawned a shell nor revived the recorded host
  ok   - reattach against a REUSED-PID record reports an honest lost session
  ok   - the reused-PID record is classified reused and not-running
  ok   - the reused-PID reattach never adopted, killed, or replaced the unrelated guard process
  ok   - no live native session remains after teardown and the lost-session probes
  ok   - the complete app-restart reattach proof NEVER invoked tmux (PATH shim sentinel absent)

ALL CHECKS PASSED
```

Windows / Linux run on the same matrix in CI. No production behaviour changed; the
proof revealed no blocker to the app-restart slice of HOST-006 / WIN-002.
