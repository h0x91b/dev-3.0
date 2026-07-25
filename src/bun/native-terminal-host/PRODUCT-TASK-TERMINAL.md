# Product task-terminal tracer (seq 1292)

End-to-end evidence for a dev3 **task's PRIMARY terminal** on the native backend —
the path a task carrying `terminalBackend: "native"` actually takes. Everything is
driven through the product surface of [`src/bun/native-task-terminal.ts`](../native-task-terminal.ts)
(`startNativeTaskTerminal` / `attachNativeTaskTerminal` / `nativeTaskTerminalAlive` /
`stopNativeTaskTerminal`), against a **real host and real shell** on the real Bun
runtime — vitest stubs the Bun global, so a live `Bun.Terminal` cannot run there.

Sibling proofs cover the layers below this one: registry lifecycle, host crash
recovery, writer/observer ownership, and app-restart reattach
([APP-RESTART-REATTACH.md](../native-terminal-registry/APP-RESTART-REATTACH.md)).
This one is the first that speaks only product vocabulary — task id in, terminal
out, no registry primitives at the call site.

## Shape

```
driver (src/bun/__tests__/native-task-terminal.bun-e2e.ts)
  │  tmpdir registry/log/image dirs + real tmux sentinel on a throwaway socket
  ├─ startNativeTaskTerminal(taskId) ─▶ detached host + shell (survive everything)
  ├─ write / onOutput round-trip · resize · detach
  ├─ spawn ─▶ native-task-terminal-controller.ts (a separate, disposable app process)
  │            attachNativeTaskTerminal ▸ same host/shell pid + replayed screen
  ├─ attachNativeTaskTerminal (writer) + raw NativeSessionClient (observer)
  ├─ stopNativeTaskTerminal ▸ owned tree dies, tmux sentinel survives
  ├─ spawn ─▶ controller again ▸ honest `attached:false`, nothing respawns
  └─ SECOND task, renderer transport (section 9):
       pty.createNativeTaskSession ─▶ ws://localhost:<ptyPort>?session=<taskId>
       renderer A + renderer B — real WebSockets, as TerminalView.tsx drives them
       ▸ destroySessionAwaited kills the tree; tmux sentinel still alive
```

## What it proves

1. **Explicit create** — one `startNativeTaskTerminal` call yields exactly ONE
   native session at the deterministic id `dev3-task-<taskId>`; host pid ≠ shell pid
   and both are alive, with the host a separate detached process.
2. **Shell round-trip** — a command written through the returned terminal comes back
   as bytes on the `onOutput` stream, echoed by the interactive ROOT shell pid.
3. **Resize** — after `resize(132, 43)` the SHELL itself reports the new geometry
   (`stty size` / `$Host.UI.RawUI.WindowSize`) and the host persists it in the record.
4. **Detach** — `detach()` drops only the app-side client: same host/shell pids stay
   alive, presence stays true, and `onClosed` never fires (a detach is not a death).
5. **App-controller restart** — a genuinely separate short-lived process reattaches
   via `attachNativeTaskTerminal`, observes the SAME host pid, shell pid, and the
   replayed screen state, and spawns no second host (session count stays 1).
6. **Single writer** — a second raw `NativeSessionClient` attaches as `observer`; its
   input and resize are both refused with `conflict` and the PTY geometry is unchanged,
   while the product writer keeps producing output.
7. **Cleanup** — `stopNativeTaskTerminal` kills exactly the owned host + shell and
   removes the registry state, while a tmux session created **before** the run (via
   the repo's `tmux` client singleton on a throwaway socket) is still alive afterwards.
8. **Honest null** — after cleanup, `attachNativeTaskTerminal` returns `null`, presence
   is false, a fresh controller process also reports `attached:false`, and nothing respawns.
9. **Renderer transport** — a SECOND, independent task id driven the way
   [`TerminalView.tsx`](../../mainview/TerminalView.tsx) drives it:
   `pty.createNativeTaskSession` registers the session (`getSessionBackend === "native"`,
   `hasDeadSession === false`), then real WebSocket clients on
   `ws://localhost:${pty.getPtyPort()}?session=<taskId>` prove that
   - native bytes reach a renderer socket through the OSC52/bell/batching pipeline,
   - a second renderer's input hits the SAME shell and **both** sockets receive its
     output (one shell, many renderers),
   - `encodeResizeSequence` from `shared/resize-protocol` lands on the PTY under the
     **smallest-client-size rule** — B reports a deliberately larger viewport, A
     reports 120x40, and the shell answers `GEOM-120-40`,
   - `destroySessionAwaited` clears `hasSession`, kills that task's host + shell tree,
     removes its registry state, and leaves the tmux sentinel alive.

Windows-capable by construction: the shell, line ending, and geometry/marker probes
branch on the platform, and the shell comes from the registry's own
`defaultNativeShellLaunchSpec` on `win32`.

## Isolation

`DEV3_NATIVE_SESSIONS_DIR`, `DEV3_NATIVE_HOST_IMAGES_DIR`, and `DEV3_LOG_DIR` are
redirected into a tmpdir that is removed at the end, so the user's `~/.dev3.0/` is
never read or written. Test-only: no production source changes.

`pty-server` is imported **dynamically**, after that redirection: importing it starts
its `Bun.serve` listener and an idle-detection `setInterval`, so the script also always
ends in an explicit `process.exit` — reached only after every check and the tmpdir
removal, and non-zero when any check failed.

## Commands

```bash
# focused product proof (macOS / Linux / native Windows, Bun 1.3.14)
bun run test:native-task-terminal-e2e
```

Also runs on the `Packaged Bun runtime` matrix (`windows-latest`, `macos-latest`,
`ubuntu-latest`) in `.github/workflows/windows-conpty-package.yml`, next to the
other native e2e steps. Skips the tmux sentinel with a printed `SKIP` line when
tmux is unavailable.

## Result (macOS, Bun 1.3.14 — 3 consecutive green runs)

```
  info - platform=darwin bun=1.3.14 session=dev3-task-00000000-0000-4000-8000-0000000e2e12
  info - tmux sentinel session live on socket dev3-native-task-e2e-10145
  ok   - the task's terminal addresses the deterministic native session id
  ok   - exactly ONE native session exists after the explicit create
  ok   - the product presence check reports the task terminal alive
  ok   - host pid and shell pid are distinct
  ok   - host + shell are alive and the host is a separate detached process
  ok   - a command written through the terminal produced its output on the onOutput stream
  ok   - the shell observed the resized geometry (132x43)
  ok   - the host persisted the new geometry in the session record
  ok   - an intentional detach is not reported as a terminal death
  ok   - the session record still names the same host + shell after detach
  ok   - host + shell survive the app-side detach
  ok   - the task terminal is still present after detach
  ok   - a separate short-lived app controller reattached through the product path
  ok   - the reattaching controller was a genuinely separate, now-gone process
  ok   - the restarted app reattached to the SAME host pid
  ok   - the restarted app reattached to the SAME shell pid
  ok   - the restarted app received the replayed screen state
  ok   - the reattach spawned NO second host or session
  ok   - the app reattached to the task terminal after the controller left
  ok   - a second raw client attaching to the same session is an observer
  ok   - the product writer keeps working while an observer is attached
  ok   - the observer's input and resize are both refused by the host
  ok   - the observer's resize never changed the PTY geometry
  ok   - cleanup terminated exactly the owned host + shell tree
  ok   - cleanup removed the owned registry state
  ok   - the pre-existing tmux sentinel session is still alive after cleanup
  ok   - reattaching to a cleaned-up task terminal returns null
  ok   - the product presence check reports the task terminal gone
  ok   - a fresh app controller also gets an honest lost session
  ok   - the lost reattach spawned NOTHING
  ok   - pty-server registered the task session on the native backend
  ok   - the native pty-server session is live, not dead
  ok   - the renderer-transport session has its own live host + shell
  ok   - the pty-server WebSocket bridge is listening
  ok   - a command sent over the renderer WebSocket came back on the same socket
  ok   - a second renderer's input reaches the SAME shell and both renderers receive its output
  ok   - the shell reports the smallest reported geometry (120x40, not B's larger one)
  ok   - pty-server dropped the session after destroySessionAwaited
  ok   - the renderer-transport host + shell tree is dead
  ok   - the renderer-transport registry state is gone
  ok   - the tmux sentinel session survived the renderer-transport teardown too

ALL CHECKS PASSED
```
