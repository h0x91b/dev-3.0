# 109 — Run agent trust/config-ensure on every spawn path

## Context
Spawning an extra Codex agent via the Spawn Agent modal (or a Codex bug-hunter)
crashed with `--profile dev3-dark cannot be used while /Users/.../.codex/config.toml
contains legacy profile = "dev3-dark" or [profiles.dev3-dark]`. A plain Codex task
launched fine.

## Investigation
`ensureCodexTrust` (in `agents.ts`) re-patches `~/.codex/config.toml` on codex ≥0.131:
it strips the legacy `[profiles.dev3-*]` tables / top-level `profile = "..."` selector
that codex now rejects and (re)writes the per-profile files. The primary launch
(`launchTaskPty` in `tmux-pty.ts`) called it before every codex launch, so config.toml
was self-healed each time. `spawnAgentInTask` and `spawnSingleBugHunterPane` resolved
the command and spawned directly, skipping the trust step entirely — so a spawned
Codex pane launched against a stale config.toml and crashed. Logs confirmed
"Codex trust ensured" only ever fired on the primary path.

## Decision
Extracted `ensureAgentTrust(worktreePath, projectPath, resolvedBaseCmd)` in
`tmux-pty.ts` (Claude trust always; Codex/Gemini gated on the resolved CLI; all
idempotent + non-fatal) and call it from all three spawn paths: `launchTaskPty`
(refactor, no behavior change), `spawnAgentInTask`, and `spawnSingleBugHunterPane`.

## Risks
The extra `ensureCodexTrust` on spawn does a synchronous version probe + a config
read/write, adding a few ms to each spawn — negligible and already paid on the
primary path. All calls stay wrapped in try/catch so a trust hiccup never blocks
a spawn.

## Alternatives considered
- Only add `ensureCodexTrust` to `spawnAgentInTask` (minimal): rejected — leaves the
  bug-hunter pane and Claude/Gemini trust gaps, and lets the two paths drift again.
- Heal config.toml only at startup: rejected — codex/config state can go stale mid-
  session; the primary path already re-heals per launch, spawns must match it.
