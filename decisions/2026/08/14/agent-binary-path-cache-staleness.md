# Agent binary path cache is invalidated by base-command edits

## Context

`checkAgentAvailability` auto-saves each agent's resolved binary path into `settings.agentBinaryPaths` so launches survive the minimal PATH of macOS `.app` bundles (see `decisions/2026/03/16/agent-binary-detection.md`). That cache was applied unconditionally: after a user edited an agent's base command (e.g. `claude` → `claude-codex`), the edit saved to `agents.json` but every launch still ran the old cached binary — and the cache never healed, because `resolveBinaryPath` prefers the custom path over a fresh PATH lookup.

## Decision

A cached/custom agent binary path applies only while its file name still matches the agent's current base command (case-insensitive, tolerating Windows launcher extensions like `.exe`/`.cmd`). Implemented as `binaryPathMatchesCommand` in `src/bun/executable.ts`, enforced at all three consumers of `agentBinaryPaths`: `applyBinaryPathOverride` (`src/bun/agents.ts`, launch command), `checkAgentAvailability` (`src/bun/rpc-handlers/settings-config.ts`, availability + auto-save), and the pre-spawn binary check in `src/bun/rpc-handlers/tmux-pty.ts`.

## Risks

A user who deliberately pointed an agent's custom path at a differently-named wrapper binary loses that override; they can instead put the wrapper's name in the base command field. Stale entries are left in settings (inert) rather than deleted, so switching the base command back revalidates the old cache for free.

## Alternatives considered

- Purging the cache entry when agents are saved with a changed base command — does not heal installs already carrying a stale entry, and leaves the tmux-pty pre-spawn check trusting a mismatched path.
- Deleting mismatched entries during `checkAgentAvailability` — unnecessary once they are inert, and keeping them lets a reverted base command reuse the cached path.
