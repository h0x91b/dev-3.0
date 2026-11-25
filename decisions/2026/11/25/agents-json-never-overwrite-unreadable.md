# agents.json: atomic writes, a lock, and never overwriting an unreadable file

## Context
h0x91b/dev-3.0#2434: after an upgrade every custom agent preset was replaced by the built-in defaults. `loadStoredAgents()` turned any parse error into `[]`, and `getAllAgents()` — called concurrently at startup — merged defaults into that empty list and saved it. `saveAgents()` wrote in place with `Bun.write`, so a second caller could read the half-written file.

## Investigation
Reproduced against the unfixed code with real Bun: a ~450 KB `agents.json` and 400 staggered `getAllAgents()` calls logged `SyntaxError: Unexpected end of JSON input` and ended with 0 of 1500 custom presets on disk. `agents.json` is only read and written by `src/bun/agents.ts`; the CLI never touches it directly.

## Decision
- `saveAgents()` goes through `atomicWriteFile` (temp sibling + rename), so a reader always sees a complete file.
- `getAllAgents()` persists the merge under `withFileLock(agents.json)` and re-reads inside the lock; `saveAllAgents()` takes the same lock.
- `src/bun/json-store-guard.ts` keeps "missing", "ok" and "corrupt" apart. A corrupt read (bad JSON, empty file, non-array) is retried for ~375 ms — an older app version may still be writing in place — then the bytes are copied to `agents.json.corrupt-<ts>` (deduplicated under a lock), and the file is rewritten from `agents-last-known-good.json` if that parses. With no usable good copy, defaults are served from memory and nothing is written until the user saves agent settings.
- Both outcomes raise an `agentsStoreNotice` (pushed, and served by `getAgentsStoreNotice` for a renderer that mounts later) that the UI shows as a sticky warning naming the backup file. A restore is never silent.
- The "unreadable, no good copy" verdict is memoized by the file's (inode, size, mtime), so the retries, backup and notice run once per file state rather than on every `getAllAgents()` call.

Degraded mode lets saves through on purpose. Refusing them would lock the user out of agent settings until they repair the file by hand, and saving loses nothing because the unreadable bytes are already in the `.corrupt-` copy. The warning says the next save replaces the file.

## Risks
The good copy has no age bound. It advances only with the hourly snapshot, and the collapse guard can freeze it for as long as the snapshots keep failing that guard. A recovery can therefore roll presets back by a lot, for example after a hand-edit typo. The edit survives in the `.corrupt-` copy, and the warning says recent changes may be missing. An older version's in-place write that takes longer than the ~375 ms retry window is judged corrupt. With a good copy present, the rename then replaces it, and the old writer finishes into an orphaned inode. `atomicWriteFile` does not fsync; it protects against torn reads and crashes mid-write, not every power-loss ordering. Older versions still write in place and do not take the lock; the retry window covers their torn writes.

## Alternatives considered
Lock only, without atomic writes: older versions and lock-free readers would still see torn files. Atomic writes only: a genuinely corrupt file would still be overwritten with defaults. Restoring from the hourly `agents-backups/` directory: the last-known-good copy is already the newest snapshot that passed the collapse guard, so it is the better single source.
