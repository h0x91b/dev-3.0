# 025 — Codex config default_permissions fallback

## Context

Codex 0.117.0 rejects `~/.codex/config.toml` when it contains `[permissions.*]` profiles without a top-level `default_permissions`. dev3 already injects `[permissions.dev3]`, so users could hit a startup failure before any launch-time overrides were applied.

## Investigation

Reproducing with `codex exec` showed the config file itself was rejected with `config defines [permissions] profiles but does not set default_permissions`. A CLI override such as `-c 'default_permissions="dev3"'` worked, but only after startup had already parsed a valid config.

## Decision

`ensureCodexConfig()` in [src/bun/codex-config.ts](src/bun/codex-config.ts) now preserves an existing `default_permissions`, but if it is missing it creates a generic `[permissions.workspace]` profile and writes `default_permissions = "workspace"`. The generated `workspace` profile is intentionally minimal: read access to the default minimal scope, write access to project roots, and network enabled.

## Risks

This introduces a dev3-managed fallback for plain Codex sessions, so future Codex changes to `workspace` semantics may require updates here. If a user expected no default profile at all, dev3 now chooses one explicitly, but only in configs that were already invalid for current Codex.

## Alternatives considered

- Set `default_permissions = "dev3"`: rejected because the chosen fallback should behave like a generic Codex workspace profile, not a dev3-specific one.
- Rely only on launch-time `-c 'default_permissions="dev3"'`: rejected because Codex validates the config file before interactive or exec runs can proceed.
