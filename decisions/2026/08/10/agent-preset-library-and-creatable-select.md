# Agents settings: a preset library, and one dropdown that accepts typed values

## Context

`DEFAULT_AGENTS` ships 5 agents and 98 presets (Claude alone has 40). Settings → Agents
rendered them as three nested accordion levels — agent row → preset row → nine-field form —
with no search, no grouping, no duplicate, and no confirmation on delete. Opening one preset
pushed the other 39 off-screen. The launch picker already decomposes the same presets into
Model → Mode via `groupLabel`/`modeLabel` (`utils/agentPicker.ts`), so the two surfaces
disagreed about what a preset even is.

## Investigation

Five candidate shapes were prototyped as a throwaway dev3 artifact (two-pane library, dense
table + drawer, guided composer, command-first/YAML editor, patched accordions) and reviewed
against `docs/ux/PRODUCT_UX_BIBLE.md`. The manifest's binding constraints: Settings is
left-nav + one detail pane (§8), modals stay ephemeral (§5), narrow shows one sibling at a
time (§12), and no new top-level destination (§9). The table shape also needed a new `hidden`
flag on `AgentConfiguration`, i.e. an on-disk schema change, for a capability nobody asked for.

## Decision

**Settings → Agents is a library**: `AgentSettingsSection.tsx` renders a toolbar (agent
`Select`, install state, `+ New preset`), a filterable preset list grouped by the launch
picker's own labels, and exactly one detail pane — `PresetEditor` for a preset, `AgentPane`
for the agent's own fields. Actions live in the editor (favorite, duplicate, make default,
reorder, delete-behind-`confirm()`); list rows carry state only. Narrow viewports show the
list, then the editor with a back affordance, via `narrowShowsEditor` + `md:` classes rather
than a viewport hook. Drag-and-drop reordering is gone — it cannot survive a filtered,
grouped list — and the up/down controls it duplicated remain.

**`Select.tsx` gained `searchable` and `allowCustom`** instead of the codebase growing a
second combobox. `searchable` renders a filter input inside the panel (focus moves into it,
`aria-activedescendant` rides the input, the trigger drops `role="combobox"` so only one
combobox exists at a time); `allowCustom` offers a "use this" row for text that matches no
option and renders an off-list current value as a selected row. Model, permission mode,
reasoning effort and max budget all use it, so a model id or effort level dev3 has never
heard of is typeable today instead of after a release.

## Risks

- Preset order is now only reachable through the editor's up/down buttons; a user who
  reordered by dragging has to relearn it.
- Two comboboxes exist on one surface conceptually (trigger + panel input); the trigger
  deliberately sheds `role="combobox"` in searchable mode, which is a deviation from the
  strict WAI-ARIA editable-combobox shape but keeps queries and screen-reader output
  unambiguous.
- A typed custom value is not validated. `buildCommandPreview` shows exactly what will run,
  which is the guard rail; a nonsense value fails at agent launch, not at save time.
- Favorites are capped at 10 with LFU eviction in the bun handler, so starring an 11th
  preset silently drops the least-used one — the editor does not warn about that.

## Alternatives considered

- **Dense table + drawer** — the only shape that buys bulk cleanup, rejected for a data-grid
  pattern Settings has no precedent for plus an on-disk `hidden` flag.
- **Guided composer as the create flow** — still wanted, but it does not fix finding a preset
  among 40; the editor's own chips-free form plus `Duplicate` covers most of its value.
- **A new `Combobox` component** — rejected under the one-primitive rule: two dropdowns means
  two keyboard contracts to keep in sync.
