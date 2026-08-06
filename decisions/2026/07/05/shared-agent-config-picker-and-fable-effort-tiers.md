# 107 — Shared AgentConfigPicker + Fable 5 effort tiers

## Context
The Provider → Model → Mode cascade picker had been added only to the Launch/Retry
modal (`LaunchVariantsModal`). Three other surfaces that pick an agent + config still
used the old two-dropdown "Agent + Configuration" form: Spawn Agent, Spawn Bug Hunters,
the global default-agent setting, and the per-column auto-launch agent. Separately, the
user asked to give Fable 5 the same Medium/X-High effort tiers Opus 4.8 already has.

## Decision
- Extracted the cascade UI into `src/mainview/components/AgentConfigPicker.tsx` (a single
  component over the `utils/agentPicker` decomposition helpers) and used it in all four
  surfaces plus `LaunchVariantsModal`. It is now the **only** UI that renders an
  agent+config selection, so new launch surfaces can't drift back to the flat dropdowns.
  It emits the full `{agentId, configId}` pair on every change so parents persist a
  consistent selection. Control ids are `${idPrefix}-provider|-model|-mode`.
- Fable 5: replaced the plain `claude-auto`/`claude-bypass` presets with explicit
  `claude-{auto,bypass}-fable5-{medium,xhigh}` (effort tiers), exactly mirroring the Opus
  4.8 change. `claude-auto`/`claude-bypass` were added to `DEPRECATED_CONFIG_IDS`
  (agents.ts), remapped to the new X-High tier in `DEPRECATED_DEFAULT_CONFIG_REMAP`
  (types.ts), and `AGENTS_LAYOUT_REVISION` was bumped 2 → 3 so existing installs slot the
  new presets into the correct in-group order.

## Risks
- Deprecating `claude-auto`/`claude-bypass` orphans any stored reference to them. Mitigated
  by the remap (global default) and the modals' existing "config not found → fall back to
  agent default" logic. This follows the already-proven Opus 4.8 precedent.
- The layout-revision bump triggers a one-time in-place rewrite of `agents.json` (allowed:
  it never renames/moves files — see the `~/.dev3.0/` invariants).

## Alternatives considered
- Inline-copying the cascade into each modal: rejected — 4× duplicated logic is exactly the
  drift that caused the missing pickers in the first place.
- Keeping the plain Fable presets and *adding* medium/xhigh alongside: rejected — it would
  not mirror Opus (three leaves vs two) and clutters the Mode dropdown.
