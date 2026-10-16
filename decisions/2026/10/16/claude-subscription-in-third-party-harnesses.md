# Claude subscription in third-party harnesses: how it would work, and why dev3 does not

## Context

With managed omp accounts (`omp-managed-accounts-via-agent-dir`), dev3 can give omp a ChatGPT/Codex subscription. The same question comes up for Claude Pro/Max. This record keeps the technical shape on file for us, or for anyone who does it instead of us, together with the provider's position.

## Investigation

- **Policy.** code.claude.com/docs/en/legal-and-compliance (read 2026-10-16) says OAuth is for "Claude Code and other native Anthropic applications". Third-party developers may not "route requests through Free, Pro, or Max plan credentials on behalf of their users" and "may not collect, store, or intermediate Claude.ai credentials or session tokens". Enforcement may come without notice, and the account at risk is the user's.
- **Where a Claude login lives.** macOS Keychain entry "Claude Code-credentials", keyed per `CLAUDE_CONFIG_DIR`, with `.credentials.json` (0600) under that dir as the fallback and as the Linux/Windows store. `claude setup-token` mints a one-year, inference-only token meant for `CLAUDE_CODE_OAUTH_TOKEN` in CI.
- **What omp accepts.** It has its own `/login anthropic` (an OAuth grant omp owns; observed to die 30 days after login whatever the refresh does) and an `ANTHROPIC_OAUTH_TOKEN` env var (a static access token, no refresh). Its Anthropic OAuth request path shapes requests to look like Claude Code. That shaping is exactly what the policy targets.

## Decision

dev3 does not build this. If someone did, the technical shape is:

1. **One owner per grant.** Never share a refresh token between Claude Code and the harness. Both rotate it, and whichever refreshes second is logged out. Either the harness holds its own grant (`omp /login anthropic` inside a managed omp account; this already works with no dev3 code), or one process owns refresh and hands out access tokens only.
2. **Delivery.** Pass the access token per launch (`ANTHROPIC_OAUTH_TOKEN`), or through a command the harness re-runs on 401 (omp's `models.yml` `apiKey: "!cmd"`). Never write it into the harness's own store.
3. **Isolation.** One record per Claude account and organization. A token is scoped to the org chosen at login, and one email can hold several orgs.
4. **Expiry.** Treat a 30-day grant lifetime as a hard re-login deadline, and warn before it.
5. **Storage.** Keychain on macOS. A 0600 file elsewhere, never in logs or telemetry.

The permitted path for omp on Anthropic models is an API key (Console) or a cloud provider (Bedrock, Vertex, Foundry), billed per token.

## Risks

- Building any of the above exposes users' accounts to enforcement and puts dev3 in the "intermediate credentials" position the policy names.
- The managed omp account flow runs omp's own `/login` untouched, `anthropic` included. dev3 neither blocks nor warns: whatever the tool supports, the user decides.

## Alternatives considered

- **Filter or warn about `anthropic` in omp accounts.** Rejected: dev3 abstracts over the tool's own login, and which provider to use is the user's responsibility.
- **Reusing dev3's managed Claude account dirs for omp.** Rejected: it shares a rotating refresh token with Claude Code and is the "intermediate" case by definition.
