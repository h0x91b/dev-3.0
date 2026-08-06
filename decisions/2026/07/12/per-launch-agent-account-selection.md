# 125 — Per-launch agent account selection

## Context

Agent accounts (Claude/Codex) were a **global singleton**: `registry.<kind>.activeId` picked one
account per provider, and switching it mutated global state (Claude via a new session's
`CLAUDE_CONFIG_DIR`, Codex by physically swapping `~/.codex/auth.json`). The switcher rendered as
`AgentAccountIndicator` under the Provider field in `AgentConfigPicker` and fired
`setActiveAgentAccount` with a billing-sensitive `confirm()`. This made it impossible to run two
concurrent sessions on different accounts (the whole point of owning several) and forced a global
context switch just to launch one task on a different login.

## Decision

The account becomes a **per-launch choice** in the three spawn surfaces — `LaunchVariantsModal`
(per-variant row), `SpawnAgentModal` (single), `BugHuntersLightbox` (single, all N hunters share
one). Each spawned session locks to the chosen account for its whole life; the former "global
active" is demoted to a **default account** = the picker's preselect, nothing more.

- **Claude:** thread the chosen `accountId` through the launch pipeline into
  `getActiveClaudeSessionEnv(accountId)` / `getActiveClaudeConfigDir(accountId)` and
  `applyClaudeAccountEnv` (`src/bun/agents.ts`). Per-session `CLAUDE_CONFIG_DIR` already isolates.
- **Codex:** switch from swapping `~/.codex/auth.json` to per-session **`CODEX_HOME`** injection
  pointing at the account's snapshot dir (a full `CODEX_HOME`: symlinked `config.toml`, own
  `auth.json`). The global file-swap (`setActiveCodexAccount`) is removed; `~/.codex` becomes the
  system login. Verified: `CODEX_HOME` relocates the entire config root including `auth.json`.
- **Persistence:** `accountId` is stored next to `agentId`/`configId` on the variant/task so Retry
  reuses it; a deleted account falls back to the default.
- **UI:** `AgentAccountIndicator` gains a local-selector mode (writes component state, no RPC, no
  `confirm()`); `AgentConfigPicker` gets a mode prop (spawn = local selection, settings = default).
  Settings → Agent Accounts relabels "active" → "default account" and drops its danger-confirm.
- **Rate-limit monitor:** `rate-limit-monitor.ts` / `rpc-handlers/agent-usage.ts` must aggregate
  Codex sessions across all per-account `CODEX_HOME` dirs — per-launch sessions no longer land in
  `~/.codex/sessions`.

## Risks

- **Codex usage/rate-limit blindness:** scattered `CODEX_HOME` session dirs break the monitor
  unless it aggregates across account dirs (handled as part of this change).
- **On-disk invariants:** per-account `CODEX_HOME` dirs are built additively under
  `~/.dev3.0/agent-accounts/codex/<id>/`; `~/.codex` is never moved/renamed (AGENTS.md hard rule).
- **Deleted account:** persisted `accountId` must fail soft to the default, never crash a launch.

## Alternatives considered

- **Global switch made explicit (dropdown that still mutates global state):** cheap but keeps the
  single-active limitation — rejected, it defeats the purpose.
- **Per-task account:** simpler, but blocks mixing accounts across variants in one task.
- **Keep Codex file-swap, layer `CODEX_HOME` only for overrides:** two coexisting mechanisms and
  lingering legacy swap — rejected in favor of a full refactor to the default-account model.
- **Auto-distribute (round-robin pool across parallel agents):** the rate-limit-spreading feature;
  explicitly deferred to a low-priority follow-up (task `4663a70c`) to keep this iteration focused.
