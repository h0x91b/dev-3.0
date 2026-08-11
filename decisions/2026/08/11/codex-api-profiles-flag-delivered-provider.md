# Codex API profiles ship their provider block as `-c` flags, never as config.toml

## Context

Settings → Agent Accounts already had "API profiles": a base URL + API key + model
stored per account and injected into new sessions. Three RPC handlers rejected
everything but Claude Code (`API profiles are only supported for Claude Code`), so a
user with an OpenAI-compatible endpoint (Baseten, OpenRouter, a local vLLM server)
could not run Codex against it from dev3 at all.

Codex resolves a custom endpoint through a `model_providers.<id>` block plus
`model_provider = "<id>"`. That block can be written into `config.toml` or passed on
the command line as repeated `-c key=value` overrides.

## Investigation

Writing the block into the account dir's `config.toml` is actively destructive here.
`CODEX_SHARED_ENTRIES = ["config.toml", "prompts"]` and `ensureCodexAccountHome()`
(`src/bun/agent-accounts.ts`) **symlink** `config.toml` from the user's real `~/.codex`
into every managed account dir. Writing through that symlink would edit the user's
global Codex configuration — for every project, agent and CLI invocation on the
machine, not just dev3's.

Setting `CODEX_HOME` for an API profile is equally wrong: there is no `auth.json` to
put there, and pointing Codex at a dev3-owned home silently drops the user's own
profiles, MCP servers and permission modes.

Codex ≥0.146 removed the `wire_api = "chat"` value entirely — it speaks only the
Responses API. A provider block declaring `wire_api = "chat"` is a **config-load
error**, so every `codex` invocation on the machine dies until the block is removed.
That is precisely the blast radius a `config.toml` write would have and a command-line
flag cannot.

Verified live against codex v0.146.0 through a real Baseten endpoint.

## Decision

A Codex API profile is delivered entirely on the command line, and its account dir is
a bare directory (`scaffoldApiProfileDir` in `src/bun/agent-accounts.ts` skips
`ensureCodexAccountHome` for `kind === "codex"`, so no `config.toml` symlink is ever
created).

`codexProviderArgs()` (`src/shared/agent-accounts.ts`, pure) builds:

```
-c model_providers.dev3.name="<label>"
-c model_providers.dev3.base_url="<baseUrl>"
-c model_providers.dev3.env_key="DEV3_CODEX_API_KEY"
-c model_provider="dev3"
```

`wire_api` is deliberately omitted so the Responses default applies. The key travels
as the `DEV3_CODEX_API_KEY` env var that `env_key` names — never as an argv token
visible in `ps`. `getActiveCodexSessionLaunch()` returns `{env, args, model}`;
`agents.ts` threads `args` through the new `CommandOptions.extraProviderArgs` into the
adapter's existing `providerArgs` seam, and `model` through `resolveLaunchConfig`'s
new `modelOverride` so the profile's model replaces the preset's `--model`.

This mirrors the existing precedent for Codex on Bedrock, which ships as
`enableArgs: ["-c", 'model_provider="amazon-bedrock"']`
(`decisions/2026/07/24/codex-bedrock-flag-delivered-provider.md`).

## Risks

- Repeated `-c` overrides are last-wins, so a preset's `additionalArgs` containing its
  own `-c model_provider=…` still beats the profile. Intentional (same ordering as
  Bedrock), but it means a hand-rolled preset can silently defeat the profile.
- The provider id is the fixed literal `dev3`. A user who already defines a
  `model_providers.dev3` block in their own `config.toml` has it overridden for dev3
  launches. Chosen over a per-account id because the flag set stays readable and the
  name collision is far-fetched.
- `DEV3_CODEX_API_KEY` is added to the Codex clearable-env set, so it is actively
  `unset` when the selected account does not set it. `CODEX_HOME` is deliberately NOT
  in that set — unsetting it would clobber a user who exports it in their own shell.

## Alternatives considered

- **Write `codexAccountDir(id)/config.toml`** — rejected: it is a symlink into the
  user's real `~/.codex` (above). Breaking the symlink to write a private file instead
  would fork the user's Codex config and silently freeze it at copy time.
- **Set `CODEX_HOME` to a dev3-owned dir with a generated config.toml** — rejected:
  loses the user's profiles, MCP servers and permission modes for that session, for no
  gain over four flags.
- **A bundled local gateway that translates to the provider** — a real option for a
  future PR (Claude Code now has an official LLM-gateway protocol), but far more moving
  parts than the problem needs, and orthogonal to Codex's own provider mechanism.
