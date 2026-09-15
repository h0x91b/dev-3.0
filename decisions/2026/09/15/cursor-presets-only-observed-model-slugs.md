# Cursor presets carry only observed model slugs, never constructed ones

## Context

The `builtin-cursor` presets were pinned to `opus-4.6-thinking`, `gpt-5.3-codex-high`
and `gemini-3.1-pro`. `cursor-agent` retired those ids and refuses at launch
(`Cannot use this model: <id>`). The presets also carried no `version`, so
`mergeWithDefaults` (`src/bun/agents.ts`) could never overwrite the stale copy in
`~/.dev3.0/agents.json` — `0 > 0` is false, so an upgrade fixed nothing.

## Investigation

We have no Cursor subscription: the installed CLI (2026.02.27-e7d2ef6) answers
`--list-models` with "No models available for this account", so the catalog could
not be read first-hand. Cursor's own docs list display names only, never CLI
slugs. Cursor bakes effort, thinking and fast into the slug itself
(`claude-opus-5-thinking-high`), so a family name plus an effort suffix is a
guess, not an id — and the catalog moves within days.

Exact slugs came from two attributable third-party observations of a live
catalog: issue h0x91b/dev-3.0#1664 (a real `cursor-agent models` run on
2026.09.02-c22c1a3) and 1jehuang/jcode#1226 (live picker, 2026-09-11). A pasted
research dump claiming 223 ids was rejected as a source: its "223" traces back to
Kangentic/kangentic#404, which reports the count but publishes no list.

## Decision

`DEFAULT_AGENTS` → `builtin-cursor` in `src/shared/types.ts` now lists eleven
presets whose `model` is a slug somebody observed in a live catalog.
`MODEL_GROUP_LABELS` in `src/mainview/utils/agentPicker.ts` names the same slugs.
The one exception is `gemini-3.8-flash-high` — the model is in Cursor's docs, the
slug follows the verified 3.7 shape, and it was requested explicitly; it is
commented as unverified in place.

These presets deliberately carry **no `version`**. A version bump is what every
other backend uses, but it clears the stored `model` and `name` wholesale, which
throws away a choice the user made on purpose. Instead `RETIRED_CURSOR_PRESET_DEFAULTS`
in `src/bun/agents.ts` names the exact agent id, preset id, model and name dev3
itself shipped, and `mergeConfig` drops a stored value only when it still equals
that byte for byte. `model` and `name` are matched independently, so a preset the
user renamed keeps its name while its dead model is still refreshed. A
user-created configuration has no matching default id and is never considered.

## Risks

A future catalog refresh has to add a row here rather than bumping a number, and
forgetting that leaves stale ids in place — the failure is loud, though
(`Cannot use this model` at launch). The equality match is exact, so a stored
value differing by whitespace or case is treated as the user's and left alone;
that errs toward preserving user data, which is the intent. Any slug shipped
today can retire again — this is a refresh, not a cure for staleness.

## Alternatives considered

Bumping `version` like the other backends: simpler, but it discards deliberate
user edits, which the task brief ruled out. Adding only new preset ids and
leaving the old ones untouched: preserves everything, but leaves the broken
presets in the list still failing at launch, so it does not fix #1664 for anyone
already onboarded. Reading the catalog from `cursor-agent --list-models` at
config time (issue #1664's own suggestion, and what Kangentic/kangentic#404 did)
is the real fix and stays open — it needs a typeahead in Settings → Agents plus
caching, a larger change than this refresh. Shipping the full combinatorial
matrix was rejected: hundreds of presets, most of them unverified.
