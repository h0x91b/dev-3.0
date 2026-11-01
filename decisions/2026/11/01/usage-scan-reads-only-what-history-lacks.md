# Usage scan reads only what the history lacks

## Context

`getAgentUsage` (`src/bun/rpc-handlers/agent-usage.ts`) read and parsed every Claude and Codex transcript on every call, synchronously, on the Bun main thread. On a Mac with 4.4 GB of transcripts one call kept the app unreachable for 20–80 s, so every other socket call (`dev3 projects list`, external-sender long-polls) timed out, and `dev3 stats usage --since 7d` gave up at the CLI's 30 s socket timeout. The Stats page triggers the same call.

## Investigation

`retainUsageHistory` already merges every record ever seen into `agent-usage-history-v1.json`, so a transcript that has not changed since a successful merge contributes nothing new. A per-file cache of folded totals would not work: one response appears in several files (streaming snapshots, resumed and copied sessions), and `mergeUsageRecord` resolves those by identity, so per-file totals do not add up. The same Mac also read everything twice: a managed Claude account's `projects` is a symlink onto `~/.claude/projects`, and roots were deduplicated by spelling, not by real path (`getTaskAgentUsage` already used `uniqueRealDirs` for this).

## Decision

- **Fingerprint map, not a record cache.** `foldedTranscripts` maps each transcript path to `size:mtime` once its records are in the history. A repeat scan stats every file and reads only new or changed ones. A changed file is re-read whole, which is safe for any rewrite, not just appends. The map is trusted only while `usageHistoryStamp()` (inode, size and mtime of the history file) matches what this process last wrote or saw. Any rewrite by another app version, or a removal, clears the map. Entries are written only when `retainUsageHistory` actually kept the records: it hands back the live states when the history is unreadable or from a newer version.
- **`since` skips old files.** `stats.usage` passes the CLI's `since`. Files whose mtime is before local midnight of that day are not read, because a transcript cannot hold a record newer than its last write. The CLI still keeps or drops whole days, so days before the window may be incomplete in that reply. No `since` gives the full report, as before.
- **Sliced parsing.** Files are read with `fs/promises` and lines are parsed in ~20 ms slices separated by `setTimeout(0)`, so the socket keeps answering during a cold scan. Concurrent callers for the same window share one scan.
- **Roots are deduplicated by real path** for Claude projects dirs and Codex stores.

## Risks

The map lives in memory, so the first scan after an app start is still cold (now 2x cheaper, sliced and off the socket's critical path). If the history file is removed during a scan, that one scan can record files whose records were lost; the next stamp check clears it. The history file itself (tens of MB on heavy installs) is still parsed and, when changed, rewritten synchronously on every call.

## Alternatives considered

A worker thread (precedent: `worktree-cleanup-scheduler.ts`) would take parsing fully off the main thread, but it needs a separately bundled entry and path wiring, and with the history, the fold state and the cache still owned by the main process it saves little over slicing. Persisting the fingerprint map would make cold starts warm, but it is a new on-disk file that must stay consistent with a history other versions also write. That can be done later if cold scans still hurt.
