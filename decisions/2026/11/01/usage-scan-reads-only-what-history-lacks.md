# Usage scan reads only what the history lacks

## Context

`getAgentUsage` (`src/bun/rpc-handlers/agent-usage.ts`) read and parsed every Claude and Codex transcript synchronously on every call. With 4.4 GB of transcripts that kept the app unreachable for 20–80 s, so other socket calls timed out and `dev3 stats usage --since 7d` hit the CLI's 30 s limit. The Stats page makes the same call.

## Investigation

`retainUsageHistory` already keeps every record ever seen in `agent-usage-history-v1.json`, so an unchanged transcript adds nothing new. Caching per-file totals would be wrong, because `mergeUsageRecord` deduplicates one response across several files. A managed Claude account whose `projects` dir links onto `~/.claude/projects` was also read twice, because roots were deduplicated by spelling.

## Decision

`foldedTranscripts` maps each path to `size:mtime` once its records are in the history; repeat scans read only new or changed files. The map is cleared whenever the history stamp (`usageHistoryStamp()`) or the model catalog differs from the last merge, since records get their catalog pricing identity only when read. A scan that skipped files reruns once without the map if the merge failed or ran against a different history (stamp seen under the lock). `stats.usage` takes `since`, files written before that local day are not read, parsing yields every ~20 ms, concurrent callers share a scan, and roots are deduplicated by real path.

## Risks

The map is in memory, so the first scan after a start is cold (sliced, about half the old cost), and two app processes sharing `~/.dev3.0` keep clearing each other's map. A `since` reply can leave days before the window incomplete, and those old records gain a newly mapped pricing identity only on the next full scan. The history file's parse and rewrite (a few hundred ms at 43 MB) and the directory walk remain synchronous.

## Alternatives considered

A worker thread (as in `worktree-cleanup-scheduler.ts`) needs a separately bundled entry, and the history, fold state and cache would still live on the main thread. Persisting the map would make cold starts warm, at the price of a new on-disk file that must stay consistent with a history other versions also write.
