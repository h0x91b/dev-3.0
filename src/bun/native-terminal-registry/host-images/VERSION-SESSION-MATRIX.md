# Version / session verdict matrix (seq 1248)

The compact contract the version-skew harness proves. `buildSkewMatrix` produces
it and `renderSkewMatrix` prints it; `lifecycle.bun-e2e.ts` asserts the live
observations match each row.

## Client × host protocol version

| host \ client | verdict | client receives | live session |
|---|---|---|---|
| host v1 ← client v1 | compatible | welcome | preserved |
| host v1 ← client v2 | version-mismatch | error: version-mismatch | preserved |
| host v2 ← client v1 | version-mismatch | error: version-mismatch | preserved |
| host v2 ← client v2 | compatible | welcome | preserved |

The invariant across **every** row: a rejected handshake closes only the
offending socket. The host process, its shell PID, pane id, endpoint, and live
shell state are never touched — `sessionPreserved` is `true` even for a
mismatch.

## Session × staged image (lifecycle)

| scenario | outcome |
|---|---|
| stage image v2 while a v1 session runs | v1 image byte-identical (no in-place replacement); v1 host/shell PIDs unchanged (no takeover) |
| new session created after v2 is staged | boots on the v2 image with a distinct host/shell PID and its own per-image entrypoint file |
| incompatible client → live session | one actionable `version-mismatch`; session stays alive and reattachable by a compatible client |
| rollback to protocol v1 (v2 also staged) | `selectImageForProtocol(root, 1)` → the v1 image explicitly; never the newest, never tmux |
| rollback to an unstaged version | `no-compatible-image` with the available versions listed; no fallback, no mutation |
| missing image | `missing` diagnostic; no session destroyed |
| partially-staged image (manifest, no entrypoint) | `partial` diagnostic naming the absent file; launch fails honestly rather than half-booting |

## Cross-platform

The vitest units (manifest, staging, rollback, boundary parity, matrix, record)
run on macOS, Linux, and Windows as part of `bun run test`. The real-process
`lifecycle.bun-e2e.ts` runs a real interactive shell — `/bin/bash` on POSIX,
Windows PowerShell on `win32` — and is invoked per platform via
`bun run test:native-host-images-e2e`.
