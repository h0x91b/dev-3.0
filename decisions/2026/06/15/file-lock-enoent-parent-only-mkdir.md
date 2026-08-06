# 069 — File-lock ENOENT branch: create parent only, then retry plain mkdir

## Context
`withFileLock` (`src/bun/file-lock.ts`) is an mkdir-based spinlock: a plain
`mkdirSync(lockDir)` is atomic and throws EEXIST when the lock is held. For a
brand-new project the parent dir (`~/.dev3.0/data/<slug>/`) may not exist yet, so
the plain mkdir throws ENOENT.

## Investigation
The ENOENT branch recovered with `fs.mkdirSync(lockDir, { recursive: true })`.
With `recursive: true`, mkdir is idempotent — it NEVER throws EEXIST and succeeds
even if the dir already exists. So two processes racing through the ENOENT branch
(desktop app + `dev3 remote`, both doing the first write for a new project) could
both "acquire" the lock and corrupt `tasks.json` via lost updates. Reproduced
deterministically by mocking `node:fs.mkdirSync` to inject a single ENOENT on the
first non-recursive attempt while the lock dir already exists
(`src/bun/__tests__/file-lock-enoent-race.test.ts`).

## Decision
In the ENOENT branch, create ONLY the parent (`fs.mkdirSync(path.dirname(lockDir),
{ recursive: true })`) and `continue` the loop to retry the atomic non-recursive
`mkdirSync(lockDir)`. EEXIST detection is preserved, so exactly one process wins.
The lock path (`<filePath>.lock`) and its plain-directory shape are unchanged.

## Risks
The retry adds at most one extra loop iteration on first-write. No behavior change
once the parent exists. Lock dir remains a plain empty directory removable by
`rmdir`, so older app versions sharing `~/.dev3.0/` keep interoperating and a
downgrade is safe (verified by backward-compat tests in `file-lock.test.ts`).

## Alternatives considered
- Keep recursive mkdir but stat-verify ownership afterward: racy and more complex
  than just preserving EEXIST.
- Pre-create all data dirs at startup: violates the "no automatic changes under
  ~/.dev3.0/" invariant and doesn't fix the general race.
