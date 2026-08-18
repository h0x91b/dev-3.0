# What Claude Code lets a gateway customize about a pinned model

## Context

A routed Claude session shows its slots in `/model` as raw wire names against generic descriptions (`openrouter/glm-5.2` · `Custom Opus model`), the effort control is offered for every routed model regardless of what the model supports, and the default row reads `openrouter/glm-5.2[1m]`. The question was which of these dev3 can influence from the launch.

## Investigation

Three sources, agreeing. [Claude Code's model-config docs](https://code.claude.com/docs/en/model-config#customize-pinned-model-display-and-capabilities) say the companion vars "take effect on third-party providers such as Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry. The `_NAME` and `_DESCRIPTION` variables also take effect when `ANTHROPIC_BASE_URL` points to an LLM gateway." The installed `cli.js` agrees: the capability lookup returns early when the provider is `firstParty`, and a base-URL redirect leaves the provider `firstParty`. And a live probe — real `claude`, isolated config dir, base URL pointed at a dead port — never changed its effort control for any value of `_SUPPORTED_CAPABILITIES`, while `_NAME`/`_DESCRIPTION` rendered exactly as given.

So effort cannot be declared per model from dev3's side. It also does not need to be: the proxy's `compat` plugin drops `reasoning` for a model whose catalog entry does not support it, which is the same job one layer down.

The `[1m]` suffix is Claude Code's own, appended because it still believes it talks to Anthropic, and it moves the auto-compact threshold from 200k to 1M. That is correct here rather than wrong: every model in the recommended set publishes a 1M window (Qwen3.8 Max 1 000 000; GLM 5.2, Kimi K3 and DeepSeek V4 Flash 1 048 576 through their top provider). An earlier commit disabled it via `CLAUDE_CODE_DISABLE_1M_CONTEXT` and was reverted for that reason.

One caveat for anyone reading a screenshot: the picker ships in two variants, and which one appears is not env-driven — the identical command produced the pinned-slot picker once and the alias picker on the next run.

## Decision

`claudePlan` in `src/shared/model-catalog.ts` emits `ANTHROPIC_DEFAULT_<SLOT>_MODEL_NAME` (the user's own catalog name) and `_DESCRIPTION` (`<provider label> · <provider-native id>`) for every slot it binds, and lists both on `unsetEnv` for every slot it does not, so a slot cannot inherit another model's label from a previously active profile. No capability vars are emitted — they would be dead weight — and 1M context is left alone.

## Risks

The vars are honoured only in one of the two picker variants, so the improvement is invisible in the other. Harmless either way: an ignored env var changes nothing.

A user-added catalog model with a smaller window still inherits Claude Code's 1M assumption and will fail upstream late in a long session rather than compacting. Fixing that properly needs a per-model context length in the catalog, which nothing models today.

## Alternatives considered

- **Declare `effort` / `thinking` per slot via `_SUPPORTED_CAPABILITIES`** — inert for a gateway (above).
- **Pin effort per model in the sidecar's config** — Bifrost has no such field; its handling is capability-driven inside the `compat` plugin, so a mapping of our own would mean patching a binary we ship pinned from upstream.
- **Put the price in `_DESCRIPTION`** — rejected: rates move, and a stale number in the agent's own picker is worse than no number. The launcher already quotes prices where dev3 can refresh them.
