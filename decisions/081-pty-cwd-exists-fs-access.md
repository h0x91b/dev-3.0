# 081 — PTY cwd existence check must use fs.access, not Bun.file().exists()

## Context

Production logs showed `ERROR [pty] PTY cwd missing` many times a day for cwds
that demonstrably existed (e.g. the project terminal's `cwd = project.path`).
The check never blocked spawning, so terminals worked anyway — it was pure
diagnostic noise polluting the ERROR log and masking any genuine missing-cwd
race.

## Investigation

A PTY's `session.cwd` is always a DIRECTORY (worktree / project path / ops
`.../work`). The check used `Bun.file(session.cwd).exists()`. Verified at runtime:

```
Bun.file(existing DIR).exists()  => false   // Bun.file has file semantics
Bun.file(existing FILE).exists() => true
fs.access(existing DIR)          => ok
```

So the check returned `false` for every valid directory, logging a bogus
"missing" each spawn — and it couldn't distinguish a real missing cwd either.

## Decision

Extracted an exported `cwdExists(cwd)` helper in `src/bun/pty-server.ts` that
uses `fs.access` (from `node:fs/promises`), which resolves directories
correctly. `spawnPty` now calls it. Still best-effort and non-blocking — only
the existence probe changed. Covered by `cwdExists` tests in
`src/bun/__tests__/pty-server.test.ts`.

## Risks

Minimal. `fs.access` with no mode arg checks F_OK (existence) — same intent as
before, now correct for dirs. Spawn behaviour is unchanged; only the log fires
accurately. Genuinely missing cwds are still logged.

## Alternatives considered

- `stat(cwd).isDirectory()` — stricter (rejects a file cwd) but the probe only
  needs reachability, and `access` is cheaper. Rejected as over-specific.
- Keeping `Bun.file().exists()` and suppressing the log — hides real races too.
  Rejected.
