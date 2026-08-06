# 014 — Memory Leak: Triple Root Cause Analysis

## Context

User reported memory growing to >21GB at ~100MB/sec with only 2 tasks running (issue #148). Log analysis of an 11K-line log file from a 2.5-hour session revealed three compounding issues.

## Investigation

Log analysis showed: 4920 git subprocess invocations, 307 `getBranchStatus` RPC calls, and a peak burst of 885 log lines/minute at 15:06 with 26 duplicate `getBranchStatus` calls in a single millisecond for the same task. The burst coincided with app wake/reconnect — all backlogged interval callbacks fired simultaneously.

## Decision

**Fix 1 — Logger** (`src/bun/logger.ts`): `appendToFile()` read the entire log file via `file.text()`, concatenated the new line, and rewrote the whole file — O(n²) in file size. Also spawned `mkdir -p` subprocess for every line. Replaced with `appendFileSync` and a cached `mkdirSync` (one-time per directory).

**Fix 2 — getBranchStatus dedup** (`src/bun/rpc-handlers.ts`): Added `branchStatusInFlight` Map to reuse in-flight Promises for the same task+ref. Same pattern as `fetchOrigin` dedup in `git.ts`.

**Fix 3 — isContentMergedInto piped** (`src/bun/git.ts`): Strategy 2 stored full `git log -p` and `git diff` output as JS strings (potentially multi-MB) just to feed them into `git patch-id --stable`. Replaced with shell pipes: `git log -p ... | git patch-id --stable` — patch data never enters JS heap. Also added lightweight `--shortstat` pre-check to skip Strategy 2 when there are no task changes.

## Risks

- `appendFileSync` is blocking — under extreme logging rates it could stall the event loop. Acceptable tradeoff given the alternative was 100MB/sec memory growth. If this becomes an issue, switch to a batched async writer.
- Shell pipe approach in `isContentMergedInto` assumes `bash` is available (always true on macOS/Linux, the target platforms).
- The `_getBranchStatusImpl` method is technically accessible from outside but prefixed with underscore to signal internal use.

## Alternatives considered

- **Async batched logger** (write every 100ms): more complex, `appendFileSync` is simpler and sufficient.
- **Rate-limiting `getBranchStatus` on renderer side**: would also work but dedup on backend is more robust — protects against any caller.
- **Streaming `git patch-id` via Bun subprocess piping**: Bun's `Bun.spawn` doesn't support native pipe chaining between processes; shell pipe via `bash -c` is simpler.
