# A keyless endpoint gets a stand-in key

## Context

The connect flow offers Ollama with `needsKey: false` — no key field at all — and a hand-entered
custom endpoint may equally authenticate nobody. `buildSidecarEnv` skipped the environment
variable for a provider with no stored key, while `buildSidecarConfig` still referenced
`env.DEV3_LLM_KEY_<PROVIDER>` for it.

## Investigation

Run against the vendored bifrost v1.6.10 with a local upstream:

| Key value | What the proxy does |
|---|---|
| absent | 400 locally: `no keys found that support model: <name>` — never dials the endpoint |
| empty string | 400, same |
| any non-empty string | request reaches upstream (502 when nothing is listening) |

So a catalog built entirely through the connect button could never serve a session, and the
failure named the model rather than the missing credential.

## Decision

`buildSidecarEnv` (`src/bun/model-sidecar.ts`) gives a provider of kind `custom` with no stored
key the constant `NO_UPSTREAM_KEY = "dev3-no-key"`. The endpoint ignores it; the proxy only needs
the variable to be non-empty. A known cloud kind (OpenRouter, OpenAI, …) keeps failing fast with
no key — it cannot work without a real one, and a placeholder would only move the refusal
upstream where the message is worse.

## Risks

- A custom endpoint that *does* require a key but has none stored now gets a 401/403 from
  upstream instead of a local refusal. The upstream message is the more accurate one.
- The constant is visible in the child process environment. It is not a credential, and nothing
  upstream accepts it.

## Alternatives considered

- **Omit the provider from the generated config entirely.** Its models then vanish from the
  catalog at launch time, which reads as data loss rather than a missing key.
- **Make the connect flow ask for a key anyway.** Asks Ollama users for a secret that does not
  exist, which is exactly the friction the flow removes.
