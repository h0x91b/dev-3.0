# 089 — Per-agent LLM provider toggle (native / third-party registry)

## Context

Claude Code can run against the Anthropic API directly or via a third-party
backend (e.g. Amazon Bedrock). dev3's built-in Claude configs select a model
with `--model` using Anthropic-API aliases (`claude-opus-4-8[1m]`, `sonnet`, …).
Third-party backends reject those — they need provider-native model ids (Bedrock
inference-profile ids like `us.anthropic.claude-opus-4-8`) — and Claude Code
selects the model from `ANTHROPIC_MODEL` in provider mode, not from `--model`. So
a dev3-launched Claude on Bedrock failed with `400 ... provided model identifier`.

Teams that route through their own cloud (data residency, compliance,
consolidated billing, an existing AWS contract) need a first-class way to point
an agent at a governed backend instead of the direct API.

## Decision

Provider is a **per-agent** setting: `CodingAgent.llmProvider` (`anthropic` =
native default, or a registered provider id) plus `CodingAgent.providerConfig`
for that agent's per-provider connection fields, persisted in `agents.json`.
Which backend an agent uses is an ops/deployment fact about *that agent*, not a
per-task choice and not an app-wide one — different agents target different
clouds (Claude→Anthropic/Bedrock, Codex→OpenAI, …), so a single global value
can't model it. The toggle lives inside each agent's expanded row in Settings →
Coding Agents and only appears for agents that have ≥1 registered backend (today:
just Claude). All of an agent's configs share its backend (per-config provider
was rejected as over-complex).

Each `ProviderDefinition` declares an `agentCommand` (e.g. `"claude"`) binding it
to an agent; `providersForAgent(baseCommand)` returns `[native, ...registered]`.
The backend resolver reads the launching agent's own `llmProvider`/`providerConfig`
(`agentProvider()` in `agents.ts`), defended so a provider id only applies to the
agent it's registered for.

Provider ids are defined as the `LLM_PROVIDER` const object in
`src/shared/types.ts` (no raw string literals at call sites), and every
third-party backend is described by a **`ProviderDefinition`** in the
`PROVIDER_REGISTRY` of `src/shared/llm-provider.ts`. The registry entry carries
the i18n label/hint keys, the enable env var (`CLAUDE_CODE_USE_BEDROCK`), whether
the provider uses the Bedrock-style geo selector, and a `mapFamily()` model
mapper. **Adding a provider = one `LLM_PROVIDER` id + one registry entry + its
i18n labels** — no call site special-cases a provider; env injection, the
settings UI, and the model table all read the registry.

- **UI** (`AgentSettingsSection.tsx` → `ProviderSelector`): a segmented selector
  rendered **inside each agent's expanded row**, built from
  `providersForAgent(baseCommand)` (native option + that agent's registered
  backends). It returns `null` for agents with no backend, so Codex/Gemini/etc.
  show no toggle. For a geo-aware provider (Bedrock), a geo toggle
  (`global`/`us`/`eu`/`apac`) sets the inference-profile prefix, and a
  pre-populated **model-mapping table** shows each of *that agent's* model aliases
  → its mapped provider id (inline-editable, Manual badge + Revert per row).
  Changing the geo re-populates every non-overridden row. No new surface, no
  toolbar button — stays within the Settings surface per the UX Bible.
- **dev3 does NOT manage credentials/region/project.** It injects only the
  provider's enable flag + the mapped `ANTHROPIC_MODEL`. Credentials/region/
  profile come from the operator's own agent config (shell env /
  `~/.claude/settings.json`). The Bedrock **geo** is only the `<geo>.` prefix of
  the model id, not the `AWS_REGION` env.
- **Model resolution** (`src/shared/llm-provider.ts`, pure/tested):
  `buildProviderEnv` + `mapModelForProvider` translate the launching config's
  model via the registry's `mapFamily()`. dev3 **always pins the model** — an
  unknown/new model is *derived* from the alias (Bedrock `global.anthropic.<fam>`)
  rather than left unset, so the control plane (dev3) and data plane (the
  launched agent) never run different models. A per-provider **model override**
  wins over the map/derivation (for region-pinned `us.`/`eu.` profiles or ARNs).
- **Injection** (`agents.ts`): for an agent under a third-party backend, the
  resolvers read the agent's own provider (`agentProvider()`), merge the provider
  env into `extraEnv` (config `envVars` still win last), and omit the `--model`
  flag. The settings-screen command preview mirrors the omission.

## Risks

- The alias→id map can lag new models — mitigated by deriving an id for unknown
  families (always pinned) plus the override field, so a missing map entry never
  hard-breaks and never silently defers to a different default.
- `global.` Bedrock profiles aren't enabled on every account; users override to
  a region-pinned id when needed.
- Provider applies to all of an agent's configs (by design). Per-config providers
  were rejected as over-complex for a rare need.
- The per-agent fields live in `agents.json` and are merged through
  `mergeWithDefaults` (user values win), so the on-disk data invariants hold with
  no schema migration.

## Alternatives considered

- **Global (app-wide) provider** — one toggle for the whole app. Rejected: a
  coding agent's backend is a property of that agent, so a single value can't
  model agents that each target a different cloud, and it only ever made sense for
  Claude.
- **Per-agent-config provider** — max flexibility, but repeats fields per config
  and doesn't match how accounts are chosen. Rejected.
- **Raw env-var flag in config `envVars`** — works but is undiscoverable and
  requires users to know every env var. Replaced by this toggle.
- **Hardcoded per-provider branches** — each new backend would touch the type,
  the resolver, and the UI. Replaced by the `PROVIDER_REGISTRY` so a provider is
  data, not code.
- **Live `aws bedrock list-inference-profiles` discovery** — always-current but
  adds an `aws` dependency, latency, and fuzzy matching. Deferred to a later
  phase (auto-discovery) on the same env plumbing.
