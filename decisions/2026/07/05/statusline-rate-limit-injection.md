# 106 — Claude rate limits via delegating statusLine injection

## Context

We needed live Claude rate-limit data (5h/7d windows, % used, reset time) with zero API calls. The only local source is the statusLine stdin JSON (`rate_limits` present since Claude Code v1.2.80; verified on v2.1.112 by a smoke test). It is NOT written to transcript JSONL files, and `userRateLimitTier` is not reliably present in `~/.claude.json`.

## Investigation

`statusLine` is a scalar setting — last-wins across settings levels (Managed > `--settings` CLI > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`), NOT additive. Naively injecting `--settings` would therefore destroy any custom statusLine the user has. Generating per-task bash wrappers that parse JSON with sed/jq was rejected as fragile and untestable.

## Decision

The app injects one static `--settings` file (`~/.dev3.0/data/rate-limits/claude-statusline-settings.json`, written by `ensureClaudeStatusLineSettings()` in `src/bun/rate-limit-monitor.ts`, appended in `resolveAgentCommand()` in `src/bun/agents.ts`) whose statusLine runs `dev3 statusline` (`src/cli/commands/statusline.ts`). The CLI dumps stdin to `~/.dev3.0/data/rate-limits/claude.json`, resolves the user's ORIGINAL statusLine from the settings precedence below the CLI level, executes it with the same stdin (2s timeout), and appends a compact usage segment. Codex needs no injection — its rollout files under `~/.codex/sessions/` already carry `rate_limits` events. A monitor (`rate-limit-monitor.ts`) polls both sources and pushes `agentRateLimitsUpdated`.

## Risks

- Managed (enterprise) settings defining a statusLine outrank `--settings`; our wrapper then never runs and Claude data is simply absent — acceptable degradation.
- If Claude Code changes the `rate_limits` stdin shape, parsing returns null and the indicator hides (no crash). The dump is a plain overwrite (no tmp+rename, honoring the ~/.dev3.0 no-rename invariant); the monitor tolerates torn reads by keeping the previous snapshot.
- The dev3 binary path (`~/.dev3.0/bin/dev3`) must exist for the wrapper to produce a segment; if missing, the user's original statusLine still renders (delegation happens inside the CLI, which in that case never ran — Claude shows a blank statusLine only if the user had none).

## Alternatives considered

- Per-task generated bash wrapper embedding the original command — rejected: bash-side JSON parsing is fragile, untestable, and needs per-launch file generation.
- Runtime resolution via jq in the statusLine command — rejected: jq is not guaranteed to be installed.
- Reading `userRateLimitTier` from `~/.claude.json` — rejected: absent on the reference machine, carries no live usage.
