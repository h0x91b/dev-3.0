# Usage collectors for OpenCode, pi and Oh My Pi

## Context

h0x91b/dev-3.0#2064 left OpenCode, pi, Oh My Pi and custom harnesses outside Productivity Stats after five collectors shipped. Each new collector had to read a documented or verifiable local store, never estimate tokens, and reuse the retained raw-snapshot history.

## Investigation

pi documents its JSONL session format (`docs/session-format.md`, `docs/message-types.md` in `@earendil-works/pi-coding-agent` 1.3.0): assistant `usage` is already split into uncached input, output, cache read/write (`cacheWrite1h` a subset), and its own `/session` totals add `usage` entries, tool-result usage and compaction/branch-summary usage. `/fork` and branch extracts copy entries verbatim, ids and timestamps included. omp 18.11.1 (bundled source, read with `strings`) keeps the same entries plus `model_usage`, nests subagent sessions under the parent, adds OpenAI `orchestration` tokens, and its own stats database deduplicates by `(entry_id, timestamp)` across session files. OpenCode 1.18.15 stores sessions in SQLite (`opencode.db`, `opencode-<channel>.db`, `OPENCODE_DB`); its processor does `message.cost += step.cost` but `message.tokens = step.tokens`, so a message keeps only its last step's tokens while every `step-finish` part keeps its own. bun:sqlite cannot open a WAL database read-only when its `-shm` is absent.

## Decision

`src/bun/usage-collectors/pi.ts` reads pi and omp sessions from the default agent dir, omp's `$XDG_DATA_HOME/omp`, and managed accounts (`listAgentDirAccountDirs`), keyed by `(entry id, timestamp)` so copies count once; each flavor mirrors that harness's own totals, and pi's model-less tool/summary usage is counted as `unknown` (visibly unpriced). `src/bun/usage-collectors/opencode.ts` sums `step-finish` parts keyed by part id, reasoning priced as output. `src/bun/sqlite-readonly.ts` opens read-only, immutably when no `-wal` exists, so nothing is created or locked beside the user's database. Each source keeps its own additive `agent-usage-history-<source>-v1.json`.

## Risks

omp's format is read from its bundled build, not a published spec, and may drift; malformed entries are skipped, not guessed. omp profiles, `PI_CONFIG_DIR`, `PI_CODING_AGENT_SESSION_DIR`/settings session-dir overrides, OpenCode's pre-SQLite JSON storage (migrated by OpenCode itself) and custom harnesses are deliberately unsupported. An immutable read racing a fresh OpenCode write can fail and is skipped until the next scan. Subscription-backed calls are still API-equivalent estimates.

## Alternatives considered

OpenCode's message `tokens` (what `opencode stats` sums) undercounts multi-step turns; its `cost` is dollars, not repriceable counts. Reading omp's `stats.db` would depend on a private cache schema instead of the session source. Opening OpenCode's database read-write would create sidecars and could checkpoint the user's file.
