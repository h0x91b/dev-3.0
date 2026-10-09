# Launch picker orders models by release date

## Context

`buildPickerGroups` grouped presets in first-seen order of the user's stored `agents.json`. `mergeWithDefaults` appends every preset a release adds to the tail of that list, so a new model (GPT-6.1 Sol, #1860) surfaced below every older generation unless the release also bumped `AGENTS_LAYOUT_REVISION`. Drag-to-reorder of presets was removed in #1391, so the stored order no longer records any user choice.

## Decision

Each model slug has a `releaseDate` in `MODEL_RELEASE_DATES` (`src/shared/model-release-dates.ts`). `buildPickerGroups` (`src/mainview/utils/agentPicker.ts`) orders groups in three tiers: agent-chosen (no model, or `auto`) first; dated models newest first; then undated groups (unknown or user models, role-bound and pxpipe-gated presets). Ties and the modes inside a group follow the `DEFAULT_AGENTS` declaration; user presets follow built-in ones in stored order. Dates before 2026-10-09 were backfilled from git (first commit shipping the slug) — provable, but not the vendor's announcement day, so bulk refreshes share a date. A harness alias takes the date of the model it serves. `model-release-dates.test.ts` fails when a shipped model has no date. Nothing is written to disk; selection, `defaultConfigId`, favorites and availability are untouched.

## Risks

Pure date order crosses families: the newest model leads even when it is the smallest (Haiku 5.5 above Opus 5.5). Backfilled dates are dev3's, not the vendor's. Flat lists that read raw `configurations` (`dev3 agent list`) still show stored order.

## Alternatives considered

- Bump `AGENTS_LAYOUT_REVISION` again: fixes one release; the next added model repeats the bug.
- Insert new defaults at their declared position in `mergeWithDefaults`: does not repair installs whose order is already fossilized.
- Declaration order alone (no dates): works, but "newest" stays implicit and nothing catches a model placed in the wrong spot.
- Date sorting inside each model family only: keeps flagships on top, but is not "sorted by when it appeared", which is what was asked.
