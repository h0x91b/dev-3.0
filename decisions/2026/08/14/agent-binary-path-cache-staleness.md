# Agent binary path cache is invalidated by base-command edits

## Context

`checkAgentAvailability` auto-saves each agent's resolved binary path into `settings.agentBinaryPaths` so launches survive the minimal PATH of macOS `.app` bundles (see `decisions/2026/03/16/agent-binary-detection.md`). That cache was applied unconditionally: after a user edited an agent's base command (e.g. `claude` → `claude-codex`), the edit saved to `agents.json` but every launch still ran the old cached binary — and the cache never healed, because `resolveBinaryPath` prefers the custom path over a fresh PATH lookup.

## Investigation

`agentBinaryPaths` turned out to carry two kinds of value with no marker: the auto-cached resolution, and the path the user types into Settings → Agents → Custom path (`setAgentBinaryPath`). A name-match rule alone cannot tell them apart, so it also silences a deliberate override — and because that field only appears when the agent is *not* found on PATH, that is exactly when users reach for it. The auto-save loop then writes the PATH hit over the user's entry, destroying it.

## Decision

The two are stored apart. `settings.agentCustomBinaryPaths` holds what the user typed and is never name-checked; `settings.agentBinaryPaths` stays the auto-cache and applies only while its file name still matches the agent's current base command (case-insensitive, launcher extensions like `.exe`/`.cmd` stripped on either side). `agentBinaryPathOverride` in `src/bun/executable.ts` encodes that precedence and is the single entry point for all three consumers: `applyBinaryPathOverride` (`src/bun/agents.ts`, launch command), `checkAgentAvailability` (`src/bun/rpc-handlers/settings-config.ts`, availability + auto-save), and the pre-spawn binary check in `src/bun/rpc-handlers/tmux-pty.ts`. `setAgentBinaryPath` writes both maps, so an older app version sharing the same `~/.dev3.0` still finds the path where it expects it.

## Risks

Installs that already carry a user-set path have it only in `agentBinaryPaths`, where it is indistinguishable from a cache entry — if its file name does not match the base command it stops applying until the user re-enters it once. Stale cache entries are left in place rather than deleted, so reverting a base command reuses the old cache; entries that still resolve keep being refreshed by the auto-save loop as before.

## Alternatives considered

- One map plus a name check for everything — the first cut of this fix. It silently ignores and then overwrites a deliberate override, with `customPathError` staying `false`, so the UI shows no reason at all.
- Storing provenance inside the existing map (`string | { path, source }`) — an older version reading the same `settings.json` would hand an object to `existsSync` and lose the path.
- Purging the cache entry when agents are saved with a changed base command — does not heal installs already carrying a stale entry, and leaves the tmux-pty pre-spawn check trusting a mismatched path.
