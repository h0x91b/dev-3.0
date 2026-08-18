# Routed Claude sessions turn the 1M-context window off

## Context

With a routed preset, `/model` inside Claude Code offered `Default (recommended) — Use the default model (currently openrouter/glm-5.2[1m])`. Nothing dev3 writes contains `[1m]`; the suffix is Claude Code's own, and no model in the curated catalog serves a 1M-token window.

## Investigation

Read out of the installed `@anthropic-ai/claude-code` bundle (v2.x, `cli.js`):

- `YX()` returns true whenever the provider is `firstParty`, and dev3 only overrides `ANTHROPIC_BASE_URL` — `pq()` still answers `firstParty`. So Claude Code appends `[1m]` to whatever the opus alias resolves to, including a third-party wire name it knows nothing about.
- `ff(model, betas)` returns `1e6` for any model whose string carries `[1m]`, against a default of `200000`. That is the auto-compact threshold, so the label is not cosmetic: the session would run past the provider's real window and fail upstream instead of compacting.
- `zq6()` reads `CLAUDE_CODE_DISABLE_1M_CONTEXT` through the usual truthy parser (`1`/`true`/`yes`/`on`) and short-circuits both the suffix and the 1M limit.

The same read closed a nearby door: `ANTHROPIC_DEFAULT_<SLOT>_MODEL_SUPPORTED_CAPABILITIES` — which would let dev3 declare per-slot support for `effort`, `thinking`, `adaptive_thinking` — is consulted through a helper that returns early when `KA()` is true, and `KA()` is also just `firstParty`. Those vars are inert for a base-URL redirect, so a routed session's effort control cannot be declared away at launch. Any effort mapping has to live in the proxy.

## Decision

`claudePlan` in `src/shared/model-catalog.ts` puts `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` into every routed Claude launch. Only routed sessions get it; an ordinary Claude launch is untouched, so a real Opus keeps its 1M option.

## Risks

If a catalog model genuinely serves 1M tokens, this caps the session at 200k. That is the safe direction, and per-model context limits are not something the catalog models today. The var is undocumented dependency internals: a Claude Code release may rename it, in which case the label returns and the wrong limit comes back with it — the guard is the unit test in `src/bun/__tests__/model-catalog.test.ts`, which only proves dev3's side.

## Alternatives considered

- **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** — honoured only together with `DISABLE_COMPACT`, which would trade a wrong limit for no compaction at all.
- **Leave it, treat it as a label** — rejected once `ff()` showed the suffix moves the compaction threshold to 1M.
- **Declare capabilities per slot instead** — impossible here: the capability vars are gated on the same `firstParty` check (above).
