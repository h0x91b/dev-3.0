# 163 — Codex on Bedrock: flag-delivered provider, fully derived model ids

## Context

The Codex agent needed Amazon Bedrock support like Claude already had (provider registry in `src/shared/llm-provider.ts`). Claude's Bedrock integration delivers the pinned model via env (`CLAUDE_CODE_USE_BEDROCK=1` + `ANTHROPIC_MODEL`, `--model` omitted). Codex has no equivalent model env var, and its Bedrock model ids follow a different scheme.

## Investigation

Validated against the live codex CLI (0.145) on a Bedrock-backed setup: `codex exec --model gpt-5.6-luna` is rejected by Bedrock with 404 (dev3's alias), while `--model openai.gpt-5.6-luna -c model_provider="amazon-bedrock"` works — as do `openai.gpt-5.6-sol/terra` and `openai.gpt-5.5`. Bedrock's OpenAI ids are flat `openai.<family>` with no cross-region geo prefix (`list-inference-profiles` shows none), unlike Anthropic's `<geo>.anthropic.<family>`.

## Decision

Generalized `ProviderDefinition` with two delivery channels instead of adding a Codex special case: `modelEnv` set → model injected via env and `--model` omitted (Claude); `modelEnv` absent → the `--model` value is rewritten to the mapped id (`applyProviderModel` in `src/bun/agents.ts`) and `enableArgs` (e.g. `-c model_provider="amazon-bedrock"`) are appended by the adapter (`providerArgs` in `agent-adapters/common.ts`). The Codex backend gets its own id `bedrock-codex` because the registry pairs one id with one agent command. Also removed `BEDROCK_FAMILY_SUFFIX`: every entry equaled the derived fallback, so model ids for all providers are now derived purely from the config alias — adding a model never requires a registry edit.

## Risks

If Bedrock ever ships an OpenAI model whose id is not `openai.<alias>`, the derived default will be wrong — the per-model override row in Settings is the escape hatch. `enableArgs` are appended before the config's `additionalArgs`, so an explicit user `-c model_provider=...` still wins. That relies on codex's repeated-`-c` last-wins semantics — observed on codex 0.145, not contractually documented; the arg ordering itself is pinned by a test (`agent-adapters.test.ts`), so if codex ever flips to first-wins only the semantics break, loudly at launch.

The live validation above covered model routing, not reasoning-effort values: whether Bedrock's OpenAI surface accepts codex's `-c model_reasoning_effort="xhigh"/"ultra"` (carried by all built-in codex presets) is unverified — if it rejects them, those presets fail on this backend with a raw codex error. The settings panel preflights the other launch prerequisite: it warns when `~/.codex/config.toml` lacks the `[model_providers.amazon-bedrock]` section (`checkCodexBedrockConfig` in `rpc-handlers/settings-config.ts`).

Regions are currently a non-issue for OpenAI on Bedrock: only US regions are supported, there are no cross-region inference profiles, and the region lives in the endpoint (codex's `[model_providers.amazon-bedrock.aws] region`), not the model id — so dev3 exposes no geo/region control for Codex. Once Bedrock offers OpenAI models in other regions, re-evaluate how dev3 should let users override the region (e.g. a per-launch `-c model_providers.amazon-bedrock.aws.region=...` enableArg or a registry-driven region selector).

## Alternatives considered

Re-keying the registry by (agent, provider) pairs (more invasive for zero user-visible gain); generating a dev3-owned codex profile with `model_provider` baked in (couples backend selection to the theme-profile mechanism, decision 055); injecting nothing and relying on the user's global `model_provider` (breaks the toggle's Native option and still 404s on dev3's aliases).
