# agents.json: atomic writes, a lock, and never overwriting an unreadable file

## Context
h0x91b/dev-3.0#2434: after an upgrade every custom agent preset was replaced by the built-in defaults. `loadStoredAgents()` turned any parse error into `[]`, and `getAllAgents()` — called concurrently at startup — merged defaults into that empty list and saved it. `saveAgents()` wrote in place with `Bun.write`, so a second caller could read the half-written file.

## Investigation
Reproduced against the unfixed code with real Bun: a ~450 KB `agents.json` and 400 staggered `getAllAgents()` calls logged `SyntaxError: Unexpected end of JSON input` and ended with 0 of 1500 custom presets on disk. `agents.json` is only read and written by `src/bun/agents.ts`; the CLI never touches it directly.

## Decision
- `saveAgents()` goes through `atomicWriteFile` (temp sibling + rename), so a reader always sees a complete file.
- `getAllAgents()` persists the merge under `withFileLock(agents.json)` and re-reads inside the lock; `saveAllAgents()` takes the same lock.
- `src/bun/json-store-guard.ts` keeps "missing", "ok" and "corrupt" apart. A corrupt read (bad JSON, empty file, non-array) is retried for ~375 ms — an older app version may still be writing in place — then the bytes are copied to `agents.json.corrupt-<ts>` (deduplicated), and the file is rewritten from `agents-last-known-good.json` if that parses. With no usable good copy, defaults are served from memory and nothing is written.

## Risks
The good copy can be up to an hour behind (it advances with the hourly snapshot), so a recovery may drop the latest edits — they survive in the `.corrupt-` copy. `atomicWriteFile` does not fsync; it protects against torn reads and crashes mid-write, not every power-loss ordering. Older versions still write in place and do not take the lock; the retry window covers their torn writes.

## Alternatives considered
Lock only, without atomic writes: older versions and lock-free readers would still see torn files. Atomic writes only: a genuinely corrupt file would still be overwritten with defaults. Restoring from the hourly `agents-backups/` directory: the last-known-good copy is already the newest snapshot that passed the collapse guard, so it is the better single source.
