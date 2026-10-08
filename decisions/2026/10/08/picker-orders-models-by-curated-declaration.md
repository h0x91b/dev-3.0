# Launch picker orders models by the curated DEFAULT_AGENTS order

## Context

`buildPickerGroups` grouped presets in first-seen order of the user's stored `agents.json`. `mergeWithDefaults` appends every preset a release adds to the tail of that list, so a new model (GPT-6.1 Sol, #1860) surfaced below every older generation unless the release also bumped `AGENTS_LAYOUT_REVISION`. Drag-to-reorder of presets was removed in #1391, so the stored order no longer records any user choice.

## Decision

`buildPickerGroups` (`src/mainview/utils/agentPicker.ts`) stably sorts an agent's presets by their index in `DEFAULT_AGENTS` before grouping. That declaration is the single source of "newest": newest generation first; inside one generation, the existing curated tier order (GPT-6 Astra, Sol, Luna; GPT-5.6 Luna, Sol, Terra), because dev3 has no trustworthy release date per model and model ids or API order are not evidence of recency. Presets dev3 does not ship have no known recency and follow the built-in ones in stored order. Nothing is written to disk; selection, `defaultConfigId`, favorites and availability flags are untouched. Codex now declares GPT-6.1 Sol above GPT-6 Astra, and Cursor Gemini 3.8 above 3.7.

## Risks

A new model placed in the wrong spot of `DEFAULT_AGENTS` shows in the wrong spot; `types.test.ts` pins the Codex lineup. Flat lists that read raw `configurations` (`dev3 agent list`) still show stored order.

## Alternatives considered

- Bump `AGENTS_LAYOUT_REVISION` again: fixes this release only; the next added model repeats the bug.
- Insert new defaults at their declared position in `mergeWithDefaults`: does not repair installs whose order is already fossilized.
- A parallel release-date table: a second list to keep in sync, with dates nobody can verify.
