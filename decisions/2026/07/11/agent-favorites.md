# 125 — Favorite agent configurations: thin pointers with LFU-then-LRU eviction

## Context

Launching an agent means walking the three-level Provider → Model → Mode picker
(`AgentConfigPicker`), whose Mode dropdown holds up to ~35 presets per provider. Users who rotate a
few fixed combinations wanted a short, cross-provider shortcut. We add **Favorites**, surfaced as a
compact leading **"Favorites" column** (peer to Provider/Model/Mode) on the three launch surfaces
only: a narrow Nerd Font star trigger (fills when the current combo is saved) opens an anchored
popover (`FavoritesMenu`) whose top row saves/removes the current combo and whose list applies /
removes a saved combo. Full design in `docs/ux/feature-plans/agent-favorites.md`. Three choices are
non-obvious and recorded here.

## Decision

1. **A favorite is a thin pointer `(agentId, configId)`, not a new preset.** It carries no config
   overrides; custom tweaks stay in the agent editor (`AgentConfiguration`). Stored globally in
   `GlobalSettings.favorites` (personal working style, like `defaultConfigId`), each entry
   `{ agentId, configId, uses, lastUsedAt }`. Menu items are ordered by `uses` desc, ties by
   `lastUsedAt` desc, and the order is **frozen while the picker is open** (recomputed on next mount) so
   items do not move under the cursor. `uses` counts **per spawned agent on any launch** of that combo
   (menu or cascade), not per menu-click; it lives on the favorite, so a freshly starred config starts
   at 0.

2. **Hard cap of 10 with LFU-then-LRU eviction, protecting the just-added entry.** Adding an 11th
   favorite evicts one of the existing 10 — victim = lowest `uses`, ties broken by oldest
   `lastUsedAt`. The newly added favorite (`uses = 0`) is **excluded** from the victim search, else it
   would evict itself immediately. This deliberately auto-deletes an explicitly starred item; it keeps
   the "short list" promise without a manage-favorites screen.

3. **Surfaced as a per-picker leading "Favorites" column, not a persistent chip row.**
   `AgentConfigPicker` is instantiated **once per variant** in `LaunchVariantsModal`, so the first cut
   — a chip row rendered inside the picker — duplicated the identical global list N times (3 variants ⇒
   3 rows) and pushed every cascade down. A second cut (a right-side `[★│▾]` split at the end of the
   row) sat *below* the Selects (its column stretched, `justify-end` pushed it to the bottom) and read
   as an ugly dangling star. The favorites now live in a **compact leading column** with its own
   "Favorites" label (so it aligns in-row with Provider/Model/Mode) and a narrow fixed-width trigger:
   a Nerd Font star that **fills gold** (`--favorite`) when the current combo is saved, opening a left-aligned portal
   popover (`FavoritesMenu`, mirrors `PriorityPicker`). The popover's **top row toggles Save ↔ Remove
   for the current combo** (save moved inside the menu — pick is the frequent path, save the rare one),
   below it the saved list (apply on click, × to remove, active row checked). The column is **always
   present** (even at 0 favorites) so "Save this combo" stays reachable. Each picker owns its own
   trigger + menu, so the multi-variant case is unambiguous and adds zero extra row height.

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
  the leading-column star trigger (+ popover) is the only affordance.
- **A single favorites row at the top of the modal** — rejected: with N variant pickers a chip click
  is ambiguous about which variant it fills. **Chips as a quick-add-variant source** — rejected: the
  chip's meaning would differ across surfaces (add-variant on Launch vs apply on Spawn/Bug Hunters).
  The per-picker control resolves both.
- **A persistent chip row inside each picker** (v1) — rejected: duplicated the global list N× and
  bloated the modal. **A right-side `[★│▾]` split control** (v2) — rejected on UX review: it dangled
  below the Selects (misaligned) and the lone thin unicode `☆` looked weak. The leading labeled column
  with an in-menu Save toggle fixes both alignment and glyph while keeping one affordance per picker.
- **1-click star save in the row + separate caret menu** — rejected in favor of moving Save into the
  popover: it collapses to a single narrow trigger (no split seam), and save is the rarer action so a
  one-extra-click cost is acceptable; the trigger star still shows saved-state at a glance.
