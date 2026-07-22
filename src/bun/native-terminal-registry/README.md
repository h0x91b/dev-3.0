# Native-session registry (seq 1214)

A **persistent, multi-session** namespace of detached native terminal hosts,
addressed by stable session id. It graduates the single-session `detached-pty`
spike into a registry that can `start`, `list`, `status`, `attach`, and `stop`
several native sessions at once, and that survives launcher/client exit: a fresh
process rediscovers every live session purely from on-disk records + private
tokens — **with no tmux involved**.

This is **not** production terminal integration and **not** the product-level
`TerminalBackend` seam. Nothing in the app (`src/bun/index.ts`) or CLI
(`src/cli/main.ts`) graph imports it (guarded by `__tests__/isolation.test.ts`),
it touches neither `pty-server.ts` nor `src/bun/tmux/`, and it writes only to an
additive, registry-only namespace. Existing tmux-backed flows — including those
of older dev3 versions on the same machine — are completely unaffected.

## Roles

| File | Role |
|------|------|
| `paths.ts` | Additive namespace + per-session paths + session-id validation. |
| `record.ts` | Versioned registry record, atomic write/read, token privacy, token-matched removal. |
| `process-identity.ts` / `-native.ts` | Liveness probe + POSIX start-signature (the reused-PID defence). |
| `ownership.ts` | Passive `owned`/`dead`/`reused` verdict — never attaches, never signals. |
| `windows-job.ts` | Token-named Job Object containment (registry namespace). |
| `protocol.ts` | Wire protocol: binary frames = PTY bytes, text frames = JSON control. |
| `journal.ts` / `journal-read.ts` | Bounded, independent per-session output journal. |
| `host.ts` | Detached process owning ONE `Bun.Terminal` shell; publishes record + token + journal. |
| `client.ts` | Short-lived attach handle; `discover(id)` reconnects a fresh process from disk. |
| `registry.ts` | `start`/`list`/`status`/`stop`/`cleanupStale`; per-session lock; injectable effects. |
| `cli.ts` | Dev-only manual driver + the `__host` re-entry the launcher spawns. |

## On-disk layout

Additive, dedicated namespace — default `~/.dev3.0/native-sessions/`, override
via `DEV3_NATIVE_SESSIONS_DIR` (tests point it at a tmpdir). Per session:

```
native-sessions/<sessionId>/
  record.json      # versioned, token-free discovery record (atomic tmp+rename)
  token            # private per-run bearer token, mode 0600 — never in record.json
  host.log         # detached host stdout/stderr
  journal.ndjson   # bounded, independent output journal (base64 frames)
```

The frozen `projectSlug()` layout and `projects.json` / `tasks.json` are never
touched, renamed, moved, or rewritten.

## Invariants

- **Ownership over PID.** A live PID alone never proves ownership. POSIX pins the
  recorded host/shell to `ps -o lstart`; Windows to token-named Job Object
  membership. A reused PID is classified `reused` and never signalled.
- **Serialised start.** Concurrent `start` of one id is serialised by a
  per-session file lock; the loser observes the winner's live record and returns
  `already-running` — never a second shell.
- **Token-matched cleanup.** `stop`/`cleanupStale` remove only state whose
  on-disk token matches, and never attach to or kill an unverified PID. An
  unknown-schema record (newer dev3) is left untouched.
- **Token privacy.** The bearer token lives only in the 0600 `token` file;
  `list`/`status` output and every serialised record are token-free.

## Try it

```bash
bun src/bun/native-terminal-registry/cli.ts start alpha
bun src/bun/native-terminal-registry/cli.ts start bravo
bun src/bun/native-terminal-registry/cli.ts list
bun src/bun/native-terminal-registry/cli.ts attach alpha   # type; Ctrl-] to detach — shell keeps running
bun src/bun/native-terminal-registry/cli.ts attach alpha   # reattach: same shell, state + journal intact
bun src/bun/native-terminal-registry/cli.ts stop alpha     # stops ONLY alpha; bravo keeps running
```

## Tests

- `bun run test:native-registry-e2e` — real-runtime lifecycle regression on
  POSIX and native Windows. Proves two simultaneous sessions, launcher-exit
  survival + fresh reattach (host/shell/state/independent journal), duplicate
  start → already-running, isolated stop, passive stale/reused cleanup, token
  privacy, and that tmux is never invoked. Expected final line: `ALL CHECKS PASSED`.
- `__tests__/*.test.ts` — vitest units for paths, record serialization, locking,
  stale detection, PID identity, ownership-safe cleanup, journal, protocol, the
  Win32 handle lifecycle, and import-graph/tmux isolation; part of `bun run test`.

See [decision 151](../../../decisions/151-native-session-registry.md) for the
record format, lifecycle invariants, and future protocol-negotiation boundaries.
