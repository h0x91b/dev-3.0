# 067 — Read caches for background polling hot paths

## Context

A one-hour log audit showed ~8,200 subprocess spawns/hour and 6,400+ full reads of `tasks.json` (1.4 MB for large projects). Main drivers: the 60s merge-detection poller, the renderer's 10-15s status polls, and `gh` auth resolution spawning 3 subprocesses per GitHub call. Repos with a dead remote were re-fetched every poller tick forever because the fetch cooldown was only set on success.

## Decision

Four independent caches, all in the bun process:

1. **`src/bun/data.ts`** — mtime+size stat-validated cache for `loadProjects()`/`loadTasks()`. `stat()` is taken *before* `readFile` so a concurrent write can only over-invalidate, never serve stale. Cache hits return shallow copies (`{...item}`); mutator paths (`strict`/`persistMigrations`) bypass the cache; saves invalidate it.
2. **`src/bun/git.ts` `fetchOrigin`** — exponential failure backoff (2 min base, doubling, 30 min cap) per `projectPath:branch` key, cleared on success.
3. **`src/bun/git.ts` `detectDefaultCompareRef`** — 10 min TTL promise cache keyed on `projectPath\0baseBranch` (it runs `git shortlog` over 2 weeks of history on every `resolveProjectConfig`).
4. **`src/bun/github.ts`** — `gh auth status` cached 60s (only the `authenticated` result, so a fresh `gh auth login` is visible immediately) and `gh auth token` cached 5 min per host+login.

## Risks

- Callers of `loadProjects()`/`loadTasks()` must treat results as read-only snapshots. Shallow copies protect against array/top-level field mutation, but nested objects (notes arrays) are shared with the cache. All mutations must keep going through `data.updateTask`/`saveTasks`.
- Multi-instance setups (prod + dev app sharing `~/.dev3.0/`) stay correct because validation is a per-read `stat()`, not in-process invalidation. Two writes within the same mtime tick AND identical file size could serve one stale read; considered negligible.
- A user-triggered git operation during a fetch failure backoff window skips the fetch (returns `false`) — same observable behavior as the fetch failing, which it just did.

## Alternatives considered

- Slowing down poller intervals: treats the symptom, degrades merge-detection latency, and doesn't fix the unbounded retry of failing fetches.
- Deep-cloning cache hits (`structuredClone`): eats most of the parse-avoidance win; rejected in favor of the read-only contract.
- Event-driven invalidation (fs watchers): more machinery for no extra correctness — stat-per-read already handles cross-process writes.
