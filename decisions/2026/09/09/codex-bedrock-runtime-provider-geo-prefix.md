# Codex on Bedrock: the Runtime provider with geo-prefixed ids; Bedrock's dated Claude ids; `jp` replaces `apac`

## Context

dev3 derives every Bedrock model id from a preset alias (`src/shared/llm-provider.ts`). A live check on 2026-09-09 (claude 2.1.266, codex 0.153.4, `aws bedrock list-inference-profiles` in us-east-1 / eu-west-1 / ap-northeast-1) found three places where the derivation named ids Bedrock does not have.

## Investigation

Codex ships two built-in Bedrock providers. `amazon-bedrock` is the OpenAI-compatible endpoint (`bedrock-mantle.<region>.api.aws/openai/v1/responses`): it takes flat `openai.<family>` ids, rejects any geo prefix with 404, and serves `openai.gpt-5.6-sol/luna/terra` and `openai.gpt-5.5` — but not `openai.gpt-6-astra`, the default codex preset's model (404 "does not exist"). `amazon-bedrock-runtime` is the Bedrock Runtime API: the bare `openai.<family>` id fails ("on-demand throughput isn't supported"), the `<geo>.openai.<family>` inference profile works (`us.` and `global.` verified), and `gpt-5.5` has no profile at all. It reads region and profile from `[model_providers.amazon-bedrock-runtime.aws]` or the `AWS_REGION` / `AWS_PROFILE` environment; no config.toml section is required for either provider.

Claude: `<geo>.anthropic.<family>` launched correctly for every preset family on `global` and `us`, and the `[1m]` suffix is accepted and reported back. `eu` has no `claude-fable-5` / `claude-fable-5-1`. No current-generation model has an `apac.` profile; Bedrock serves that geography as `jp.` (opus-4-7, opus-4-8, sonnet-4-6, haiku only). Two families keep a dated id on Bedrock and 400 on the bare form: `claude-haiku-4-5` → `claude-haiku-4-5-20251001-v1:0`, `claude-opus-4-6` → `claude-opus-4-6-v1`.

## Decision

`PROVIDER_REGISTRY[bedrock-codex]` now routes at `amazon-bedrock-runtime` with `usesGeo: true` and `mapFamily = <geo>.openai.<family>`, so the default preset works and Codex gets the same geo selector as Claude; the trade is that the gpt-5.5 presets have no Bedrock id on this provider (the per-model override row remains the escape hatch). `BEDROCK_ANTHROPIC_IDS` carries the two dated Claude ids. `BEDROCK_GEOS` offers `jp` instead of `apac`; `normalizeBedrockGeo` reads a stored `apac` as the default so an existing settings file keeps working without being moved or rewritten. `BEDROCK_GEO_GAPS` + `bedrockModelServedInGeo` are an advisory snapshot that marks a Settings row "Not in this region" — never blocks a launch, never flags a model it has no data for. The `checkCodexBedrockConfig` RPC and `hasModelProviderSection` are deleted: the section they demanded was never required.

## Risks

`BEDROCK_GEO_GAPS` is a dated snapshot; when Bedrock adds a profile the marker turns false-positive until someone re-runs the listing. It is advisory only, so the cost is a misleading badge, not a broken launch. If Mantle later gains gpt-6-astra, the Runtime choice still holds (Runtime serves every model Mantle does except gpt-5.5) but is no longer forced.

## Alternatives considered

Keeping Mantle and marking gpt-6-astra unavailable: leaves the default preset broken. Hiding unavailable rows instead of marking them: a hidden row cannot be pinned to an ARN. Keeping `apac` alongside `jp`: an option that fails for every preset is not an option.
