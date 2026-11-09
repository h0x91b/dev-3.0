# Lean protocol as a Settings toggle

## Context

The lean launch protocol (`decisions/2026/10/02/lean-protocol-opt-in.md`) could only be enabled with `DEV3_LEAN_PROTOCOL=1` on the server process. Desktop users launching from Finder or the in-app updater have no practical way to set an environment variable.

## Decision

Global settings gain `leanAgentProtocol` (normalised to `true` or absent in `src/bun/settings.ts`). The async launch paths in `src/bun/agents.ts` pass it as `CommandOptions.leanProtocol`, and `leanProtocolBody` is on when that is true OR the env var is `1`, read per launch. Agents settings shows the toggle; `getAppVersion` reports `leanProtocolForcedByEnv` so the toggle renders locked on with a hint when the env var decides.

## Risks

Same as the original record: agents follow on-demand docs less reliably than injected text. A resumed session can get a different body from its first launch if the toggle flipped in between. Callers of `resolveAgentCommand` that skip the settings-aware launch paths get the env flag only.

## Alternatives considered

A synchronous settings read inside `leanProtocolBody` (rejected: the launch paths already hold loaded settings). A dedicated RPC for the env state (rejected: one boolean on an existing response is smaller).
