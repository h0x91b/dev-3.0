# Detached-PTY prototype (spike)

A narrow, self-contained tracer proving that a **detached Bun process can own a
single `Bun.Terminal` shell** while short-lived clients disconnect and later
reattach to the same live shell — **with no tmux involved**. Groundwork for the
tmux-removal roadmap (parent seq 1141).

This is a spike, NOT production terminal integration and NOT a `TerminalBackend`
abstraction. It is imported by nothing in the app (`src/bun/index.ts`) or CLI
(`src/cli/main.ts`) graph, touches neither `pty-server.ts` nor `src/bun/tmux/`,
and writes only to an additive, prototype-only metadata dir. Existing tmux-backed
terminal flows — including those of older dev3 versions on the same machine — are
completely unaffected.

## Roles

| File          | Role |
|---------------|------|
| `host.ts`     | Detached process that owns ONE `Bun.Terminal` shell and serves attach/input/output/resize/status/stop over the transport. |
| `launcher.ts` | `start()` spawns the host detached and waits for readiness, then returns without killing it; `stop()`/`status()` rediscover it from metadata. |
| `client.ts`   | Short-lived attach handle; `discover()` reconnects a fresh process from metadata alone. |
| `state.ts`    | Discovery metadata (`~/.dev3.0/pty-proto/state.json`, override via `DEV3_PTY_PROTO_DIR`). |
| `protocol.ts` | Wire protocol: binary frames = PTY bytes, text frames = JSON control. |
| `cli.ts`      | Manual driver + the `__host` re-entry the launcher spawns. |

## Design choices

- **Transport = WebSocket over loopback TCP (`127.0.0.1:0`) + per-run token.**
  Chosen over a Unix socket because it works on Windows and POSIX alike, and
  over raw TCP because WebSocket gives message framing for free (one socket, two
  channels). Mirrors the proven `pty-server.ts` / `dev3 remote` transports.
- **Detached lifecycle mirrors `dev3 remote --detach`:** the host writes a state
  file as its readiness signal; the launcher polls it, then exits; separate
  processes rediscover the host via that file.
- **Stop = process-group kill.** `Bun.Terminal` makes the shell a session leader,
  so on POSIX `kill(-shellPid)` reaps the whole tree; Windows falls back to
  killing the subprocess directly.

## Try it

```bash
bun src/bun/prototypes/detached-pty/cli.ts start
bun src/bun/prototypes/detached-pty/cli.ts attach   # type; Ctrl-] to detach — shell keeps running
bun src/bun/prototypes/detached-pty/cli.ts attach   # reattach: same shell, state intact
bun src/bun/prototypes/detached-pty/cli.ts status
bun src/bun/prototypes/detached-pty/cli.ts stop
```

## Tests

- `bun run test:proto-e2e` — the targeted integration test (real Bun runtime):
  start → attach → disconnect → reattach → stop, plus a PATH-shim proof that tmux
  is never invoked. Runs on real Bun because vitest stubs the `Bun` global (so a
  live `Bun.Terminal` cannot run there) — same reason as `test:pane-e2e`.
- `__tests__/protocol.test.ts`, `__tests__/state.test.ts` — vitest unit tests for
  the pure logic; part of `bun run test`.
