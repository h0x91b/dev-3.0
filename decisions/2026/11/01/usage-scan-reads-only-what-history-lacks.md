# Usage scan reads only what the history lacks

## Context

`getAgentUsage` (`src/bun/rpc-handlers/agent-usage.ts`) read and parsed every Claude and Codex transcript on every call, synchronously, on the Bun main thread. On a Mac with 4.4 GB of transcripts one call kept the app unreachable for 20–80 s, so every other socket call (`dev3 projects list`, external-sender long-polls) timed out, and `dev3 stats usage --since 7d` gave up at the CLI's 30 s socket timeout. The Stats page triggers the same call.

## Investigation

`retainUsageHistory` already merges every record ever seen into `agent-usage-history-v1.json`, so a transcript that has not changed since a successful merge contributes nothing new. A per-file cache of folded totals would not work: one response appears in several files (streaming snapshots, resumed and copied sessions), and `mergeUsageRecord` resolves those by identity, so per-file totals do not add up. The same Mac also read everything twice: a managed Claude account's `projects` is a symlink onto `~/.claude/projects`, and roots were deduplicated by spelling, not by real path (`getTaskAgentUsage` already used `uniqueRealDirs` for this).

## Decision

- **Fingerprint map, not a record cache.** `foldedTranscripts` maps each transcript path to `size:mtime` once its records are in the history. A repeat scan stats every file and reads only new or changed ones. A changed file is re-read whole, which is safe for any rewrite, not just appends. A file that failed to read is never stamped. The map is trusted only while `usageHistoryStamp()` (inode, size and mtime of the history file) matches the stamp this process last merged into. A rewrite by another app version, or a removal, clears the map. A scan that skipped files also checks the stamp `retainUsageHistory` saw under its lock, and whether the merge was kept (it hands back the live states when the history is unreadable, unwritable or from a newer version). If either check fails, the map is dropped and the scan reruns once without it, so the reply equals a full fold and a replaced history gets every record back.
- **`since` skips old files.** `stats.usage` passes the CLI's `since`. Files whose mtime is before local midnight of that day are not read, because a transcript cannot hold a record newer than its last write. The CLI still keeps or drops whole days, so days before the window may be incomplete in that reply. No `since` gives the full report, as before.
- **Sliced parsing.** Files are read with `fs/promises` and lines are parsed in ~20 ms slices separated by `setTimeout(0)`, so the socket keeps answering during a cold scan. Concurrent callers for the same window share one scan.
- **Roots are deduplicated by real path** for Claude projects dirs and Codex stores.

## Risks

The map lives in memory, so the first scan after an app start is still cold: about 2x cheaper, sliced, and no longer blocking the socket. Two app processes sharing `~/.dev3.0` (a release and `bun run dev`) rewrite the history whenever agents produce usage, so each clears the other's map and falls back to sliced cold scans. The results stay correct; only the cost returns. A history that cannot be written makes every warm scan a cold one, for the same reason. Still synchronous on every call: the history file's read, parse, merge and (when changed) rewrite, which takes a few hundred ms at 43 MB; the directory walk with one `stat` per transcript; the Gemini, Copilot, Cursor and pi collectors; and `finalizeUsage`. A cold scan without `--since` can still take longer than the CLI's 30 s timeout on very large stores; a retry joins the running scan.

## Alternatives considered

A worker thread (precedent: `worktree-cleanup-scheduler.ts`) would take parsing fully off the main thread, but it needs a separately bundled entry and path wiring, and with the history, the fold state and the cache still owned by the main process it saves little over slicing. Persisting the fingerprint map would make cold starts warm, but it is a new on-disk file that must stay consistent with a history other versions also write. That can be done later if cold scans still hurt.
