# 178 — Shell-free git → git patch-id streaming pipeline

## Context

`isContentMergedInto()` (`src/bun/git.ts`) detected squash/rebase merges by piping
`git diff` / `git log -p` into `git patch-id --stable` through three
`bash -c "… | …"` calls. Windows has no native `bash`: PATH resolves it to WSL
bash, whose filesystem view does not match the native worktree cwd, so every
pipeline exited 128 and merge detection silently reported "not merged" (found
during Seq 1295 real-Windows validation).

## Investigation

The failure is the shell, not git: the same `git` invocations succeed when spawned
directly with the native cwd. Only Strategy 2 (patch-id) was affected; Strategy 1
(merge-tree) and Strategy 3 (GitHub PR) already spawn git/gh as plain argv.

## Decision

Added `runGitPipe(producerCmd, consumerCmd, cwd, { prefix })` in `src/bun/git.ts`.
It spawns both sides via the `src/bun/spawn.ts` wrapper (`stdin: "pipe"` on the
consumer), copies producer stdout into the consumer's `FileSink` chunk by chunk,
awaiting `flush()` between chunks for backpressure, and drains all three remaining
pipes before awaiting exits. Optional `prefix` bytes replace the shell-`echo`
synthetic `commit <zero sha>` header. Failure is deterministic: either non-zero
exit, a spawn error, or a broken pipe yields `ok: false` with both stderrs joined,
and the surviving child is killed so nothing is orphaned. All three call sites in
`isContentMergedInto()` now use it; no shell is involved anywhere in the function.

Side effect: the pipeline now goes through `withGitFilenameEncoding`, so patch
headers use `core.quotepath=false`. Both sides of every comparison are produced the
same way and patch-ids are never persisted, so results are unchanged.

## Risks

The consumer's stdin is Bun's `FileSink`; the backend test spawn mock had to grow a
Node-writable adapter (`nodeStdinAsFileSink` in `src/bun/__tests__/git-test-helpers.ts`)
to model `write`/`flush`/`end`, so mocked flush timing is an approximation of Bun's.
A per-chunk `flush()` costs a microtask per chunk versus letting the kernel pipe
handle it, which is negligible next to git's own work.

## Alternatives considered

- Pass `producer.stdout` straight as the consumer's `stdin` (Bun accepts a
  ReadableStream). Less explicit control over broken-pipe and error ordering, and
  no place to inject the synthetic commit header.
- Buffer the patch in JS and feed it as a Blob — reintroduces the multi-MB memory
  cost the original bash pipeline existed to avoid.
- PowerShell pipelines on Windows — text-oriented, would corrupt binary patch bytes.
- Reimplement patch-id in JavaScript — must match git's hashing exactly, forever.
