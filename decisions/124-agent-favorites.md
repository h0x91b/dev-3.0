# 124 — Favorite agent configurations: thin pointers with LFU-then-LRU eviction

## Context

Launching an agent means walking the three-level Provider → Model → Mode picker
(`AgentConfigPicker`), whose Mode dropdown holds up to ~35 presets per provider. Users who rotate a
few fixed combinations wanted a short, cross-provider shortcut. We add **Favorites**: a curated row of
chips above the cascade, on the three launch surfaces only. Full design in
`docs/ux/feature-plans/agent-favorites.md`. Two choices are non-obvious and recorded here.

## Decision

1. **A favorite is a thin pointer `(agentId, configId)`, not a new preset.** It carries no config
   overrides; custom tweaks stay in the agent editor (`AgentConfiguration`). Stored globally in
   `GlobalSettings.favorites` (personal working style, like `defaultConfigId`), each entry
   `{ agentId, configId, uses, lastUsedAt }`. Chips are ordered by `uses` desc, ties by `lastUsedAt`
   desc, and the order is **frozen while the picker is open** (recomputed on next mount) so chips do
   not move under the cursor. `uses` counts **per spawned agent on any launch** of that combo (chip or
   cascade), not per chip-click; it lives on the favorite, so a freshly starred config starts at 0.

2. **Hard cap of 10 with LFU-then-LRU eviction, protecting the just-added entry.** Adding an 11th
   favorite evicts one of the existing 10 — victim = lowest `uses`, ties broken by oldest
   `lastUsedAt`. The newly added favorite (`uses = 0`) is **excluded** from the victim search, else it
   would evict itself immediately. This deliberately auto-deletes an explicitly starred item; it keeps
   the "short list" promise without a manage-favorites screen.

Stale favorites are remapped via `DEPRECATED_DEFAULT_CONFIG_REMAP` (as `defaultConfigId` is), hidden
at render if still unresolvable, and **never purged from storage** — `settings.json` is shared across
app versions on one machine, so an older version must not delete a favorite a newer one added (same
cross-version-safety principle as the frozen `~/.dev3.0/` layout, applied to content).

## Risks

- Auto-eviction removes a control the user explicitly set. Mitigated by LFU-first (heavy-hitters are
  protected over rarely-used ones) and the 10-item ceiling being generous for a curated list.
- Frequency ordering + recency tie-break means a high-`uses` but cold favorite still sorts near the
  front yet is eviction-safe (LFU protects it) — display and eviction keys differ by design.

## Alternatives considered

- **Favorite as a first-class custom preset** (own name/args) — rejected: duplicates the agent editor
  and guarantees drift; the pointer stays thin.
- **Pure LRU eviction** (evict oldest `lastUsedAt`) — rejected: would evict your most-used combo after
  a short cold spell. **Pure LFU** — rejected as the sole rule; combined LFU-then-LRU is the tie-break.
- **Display cap without eviction** (show top-N, keep the rest) — rejected by the user in favor of a
  true bounded set that self-prunes.
- **Per-project favorites / a Settings manage screen / a discovery tip** — rejected as scope creep;
  the always-visible star button is the only affordance, and the empty row is hidden.
