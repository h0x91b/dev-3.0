# Feature plan — Favorite agent configurations

**Status:** Designed (grilled), not yet implemented.
**Implementation:** tracked in a separate dev3 task (see the parent task's notes for the id).
**Related:** [decision 124](../../../decisions/124-agent-favorites.md), `docs/ux/feature-plans/agent-picker-provider-model-mode.md` (the underlying Provider → Model → Mode picker).

## Problem

Picking an agent for a launch means walking the three-level **Provider → Model → Mode** cascade
(`AgentConfigPicker`), whose Mode dropdown can expand to ~35 presets per provider. A user who
routinely rotates a handful of specific combinations (e.g. Sonnet 5 · Bypass · Medium, Fable 5 ·
Bypass, a particular Codex mode) has to re-dial the full cascade every time. We want a short,
curated, cross-provider shortcut so the common combos are one click away — without hiding the full
cascade for discovery.

## Domain

- **Favorite** — a thin *pointer* to an existing configuration: the pair `(agentId, configId)`. It is
  **not** a new kind of preset and carries no config overrides of its own; custom tweaks stay in the
  agent editor (`AgentConfiguration`). The word "preset" is already taken by `AgentConfiguration`, so
  the user-facing term is **Favorites / Избранное**, never "presets".
- **Usage counter** — per-favorite `uses` count plus `lastUsedAt`, used both to *order* the chips and
  to decide *eviction* when the list is full.

## Data model

Add to `GlobalSettings` (`src/shared/types.ts`) — global, not per-project (favorites are a personal
working style, like `defaultConfigId`):

```ts
export interface FavoriteAgentConfig {
	agentId: string;
	configId: string;
	/** Launches with this (agentId, configId); +1 per spawned agent. Starts at 0. */
	uses: number;
	/** epoch ms. Set on add and updated on every use. */
	lastUsedAt: number;
}

// GlobalSettings
favorites?: FavoriteAgentConfig[]; // capped at MAX_FAVORITES (10)
```

New optional field → no migration needed; absent = `[]`. Never auto-purged (see stale handling).

## Ordering

- **Display order:** `uses` descending, ties broken by `lastUsedAt` descending (most recent first).
- **Frozen per picker open:** the order is computed when the picker mounts and does **not** reshuffle
  while it is open. The next open reflects updated stats. (Avoids chips moving out from under the
  cursor mid-interaction.)

## Cap & eviction

- **Hard cap = 10** (`MAX_FAVORITES`). This is an *eviction* cap, not just a display cap — the stored
  list is always ≤ 10, and every stored favorite is shown.
- **On add when full:** choose the victim among the **existing 10** by lowest `uses`, ties broken by
  oldest `lastUsedAt` (a combined LFU-then-LRU rule); remove it, then insert the new favorite.
- **The just-added favorite is never the victim.** A fresh favorite has `uses = 0`; without this
  protection it would immediately be the lowest-`uses` entry and vanish. Eviction runs over the prior
  10 only, so an explicit "add" always takes effect.

## Usage increment

- The counter measures *"how often I actually run this config"*, so **any launch** whose
  `(agentId, configId)` matches a favorite increments it — whether the user clicked a favorite chip or
  dialed the cascade to the same combo.
- **Granularity:** per spawned agent. Launching N variants of the same config = `+N`. Bug Hunters
  spawning N hunters on one config = `+N`.
- On increment: `uses++`, `lastUsedAt = Date.now()`.
- Non-favorited configs are **not** tracked (the counter lives on the favorite entry). A freshly
  starred config therefore starts at `uses = 0` and climbs with use — it does not inherit prior
  cascade usage.

## UI

- **Chips row** above the Provider/Model/Mode cascade, with a small left-aligned **"★ Favorites"**
  label. Cross-provider, one row. Clicking a chip **only selects** (fills all three cascade fields);
  it does **not** launch — launch stays the dedicated button (variant count / description must not be
  skipped, and Bug Hunters/Spawn have their own launch semantics).
- **Empty state:** when there are no favorites, the row (and label) is not rendered at all —
  progressive disclosure, zero chrome for new users.
- **Add / remove:** a **star toggle button** at the end of the cascade row reflects and toggles
  whether the *current* `(agentId, configId)` is a favorite (filled = favorited, outline = not).
  Removal is also possible via a small `×` on chip hover.
- **Chip label:** `Provider · Model · Mode`, provider compact (icon if available, else short tag) —
  e.g. `Claude · Sonnet 5 · Bypass · Med`. Provider is required because model names collide across
  providers (Opus 4.6, GPT-5.3 Codex, Gemini 3.1 Pro appear under more than one). Reuse
  `getModelGroupLabel` + `getModeLeafLabel` from `src/mainview/utils/agentPicker.ts`.

## Surfaces

Favorites appear only on the three **launch** surfaces, gated by a new `showFavorites` prop on
`AgentConfigPicker`:

- `LaunchVariantsModal` (Launch / Retry)
- `SpawnAgentModal` (Spawn Agent)
- `BugHuntersLightbox` (Bug Hunters)

The two **Settings** render sites (`AgentSettingsSection`, `ProjectSettings`) keep the plain cascade —
there the picker sets a *default agent*, and a parallel "favorites" affordance would muddy
"default vs favorite".

## Stale / invalid favorites

- Apply `DEPRECATED_DEFAULT_CONFIG_REMAP` on read (same as `defaultConfigId`) so renamed default
  configs survive.
- Chips whose `(agentId, configId)` still does not resolve to a current config are **hidden at render
  time**, but **never purged from storage** — `settings.json` is shared across app versions on one
  machine, and a newer version may know a config an older one does not. (Same cross-version-safety
  principle as the frozen `~/.dev3.0/` layout; here it is content, not paths, but the trap is
  identical.)
- Uninstalled-agent favorites render normally; the "not installed" state surfaces in the Provider
  dropdown on select, exactly as the cascade does today.

## Discoverability & naming

- **No onboarding, no "Did you know?" tip.** The star toggle button is always visible and
  self-describing; per the project tip policy a visible, self-explaining control does not earn a tip.
- **User-facing name:** Favorites / Избранное. i18n keys under an `agentFavorites.*` (or `launch.*`)
  namespace across en/ru/es.

## Persistence / RPC

- Stored in `GlobalSettings.favorites`, loaded/saved via the existing `loadSettings` / `saveSettings`.
- **Toggle (add/remove)** is renderer-initiated → a dedicated RPC handler (e.g. `toggleFavoriteAgent`
  / `setFavorites`) in `src/bun/rpc-handlers/settings-config.ts`; applies the cap + eviction rule
  server-side so the invariant lives in one place.
- **Increment** happens in the launch path (main process — `task-lifecycle` / `tmux-pty` handlers
  that actually spawn agents), guarded to only touch entries already in `favorites`.

## Testing

- Unit: ordering (uses desc, lastUsedAt tie-break), eviction (LFU-then-LRU, new-add protection),
  increment (per-agent, only-if-favorited), stale remap + hide-not-purge.
- Component: chips row renders/hides on empty; chip click selects (does not launch); star toggle
  reflects + flips current combo; `×` removes; `showFavorites` off → nothing rendered.

## Out of scope / follow-ups

- Manual drag-reorder of chips (ordering is frequency-driven for now).
- A `+N more` overflow affordance (hard cap of 10 makes it unnecessary).
- Per-project favorites, custom chip names, and "suggest a favorite" from cascade usage.
