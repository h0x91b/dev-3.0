# 096: One-time resync of built-in agent preset order

## Context

`mergeWithDefaults` (`src/bun/agents.ts`) preserves a user's stored
`configurations` order forever, appending newly-added default presets at the
tail — this is intentional, so drag-to-reorder (`ReorderControls` in
`AgentSettingsSection.tsx`) survives future preset additions. But it also
means any *reordering* of `DEFAULT_AGENTS` in `src/shared/types.ts` never
reaches an already-onboarded install: their `~/.dev3.0/agents.json` keeps
whatever relative order it had from whenever they first ran the app, which
can be a years-old fossil (verified on a real install: stored Claude preset
order was `Bypass, Default, Plan, Auto, ...`, predating the
"Auto/Bypass-first" convention introduced later). Every subsequent reshuffle
of `DEFAULT_AGENTS` was invisible to that install — new presets just piled up
at the bottom of the dropdown.

## Decision

Added a one-time forced resync, gated by a new `agentsLayoutRevision` field
on `GlobalSettings` (`src/shared/types.ts`):

- `applyLayoutResync()` (`src/bun/agents.ts`) is a pure function: for each
  built-in agent, it reorders `configurations` to match the current
  `DEFAULT_AGENTS` declared order, appending any non-default (user-created)
  configs after, in their existing relative order.
- `getAllAgents()` calls it once: if `settings.agentsLayoutRevision` is
  behind `AGENTS_LAYOUT_REVISION` (bumped in code), it resyncs, persists via
  `saveAgents`, and bumps+saves the revision. After that, normal
  order-preserving merge resumes — the user's future drag-reordering
  persists as before.

This is a one-time nudge, not a permanent behavior change to `mergeWithDefaults`.

## Risks

- This *does* discard any manual drag-reordering of built-in presets a user
  did *before* this revision ships — it can't distinguish "stale legacy
  fossil" from "deliberately dragged." Content overrides (`envVars`,
  `maxBudget`, custom `model`/`additionalArgs` set via version-bump-exempt
  fields) are unaffected — only ordering is touched.
- Bumping `AGENTS_LAYOUT_REVISION` again in the future re-triggers the same
  one-time resync for everyone, so it should only be bumped for genuinely
  significant reshuffles, not routine preset additions.
- Config ids removed/renamed in the same pass as this resync must be added
  to `DEPRECATED_CONFIG_IDS`, or they'd linger in `applyLayoutResync`'s
  "unmatched, keep as user-created" bucket as phantom presets.

## Alternatives considered

- **Change `mergeWithDefaults` to always sort by declared order** — rejected:
  permanently kills drag-to-reorder persistence for built-in presets.
- **New explicit `sortIndex` field + drag sets an override** — the "correct"
  long-term fix, but a bigger refactor than this cleanup warranted.
- **Manual "Reset to defaults" button, no automatic migration** — safest, but
  leaves the current mess in place until the user finds and clicks it.
