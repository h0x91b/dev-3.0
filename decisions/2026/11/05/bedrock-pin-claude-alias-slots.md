# Bedrock launches pin Claude Code's alias slots

## Context

The Bedrock provider set only `ANTHROPIC_MODEL`. Claude Code resolves `/model haiku`, `/model sonnet` and a subagent's `model: haiku` through `ANTHROPIC_DEFAULT_<SLOT>_MODEL`, and falls back to built-in ids when those are unset. Checked live with Claude Code 2.1.318: `haiku` went to `us.anthropic.claude-haiku-4-5-20251001-v1:0` (403 on an account that allows only `global.` profiles) and `sonnet` to `us.anthropic.claude-sonnet-4-5-20250929-v1:0`.

## Decision

`ProviderDefinition.pinsAliasSlots` (Bedrock-Claude only) makes `buildProviderEnv` in `src/shared/llm-provider.ts` also set the four slot vars. The launching model owns its own slot, so a slot never disagrees with `ANTHROPIC_MODEL`. Every other slot gets the newest `builtin-claude` preset model of that slot (ranked by `MODEL_RELEASE_DATES`) that the geo serves, mapped through `providerPinnedModel`, so geo and per-model overrides apply. Preset `envVars` are applied after the provider env and still win; a preset `ANTHROPIC_MODEL` also takes its launch slot (`presetModelSlotEnv`), because `applyModelOverride` prefers the slot var. A slot the geo serves no model for gets the launching model.

## Risks

The derived slots now beat an API profile's or the project env's own `ANTHROPIC_DEFAULT_*_MODEL`; a per-model override in the Bedrock settings is the way to change one. Slot ids keep `[1m]`, so `/model opus` and opus subagents run with 1M context; Claude Code 2.1.318 accepted it live (`global.anthropic.claude-opus-5-5`).

The ids are derived, not checked against the account's entitlements; an account lacking a model still fails on that model, now with the current id instead of an old one. `BEDROCK_GEO_GAPS` is an advisory snapshot, so a slot can be pinned to a model a geo stopped serving.

## Alternatives considered

A hand-kept slot table would drift from the presets. Querying `list-inference-profiles` at launch needs AWS calls and credentials in the launcher, which dev3 deliberately does not manage.
