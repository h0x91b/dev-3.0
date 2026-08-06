# Codex Config Version Syntax

## Context

Codex 0.129 renamed the hook feature flag from `codex_hooks` to `hooks`, and Codex 0.131 renamed the filesystem special path from `:project_roots` to `:workspace_roots`. New Codex versions warn on the old names, while older versions may not understand the new names.

## Investigation

The generated config in `src/bun/codex-config.ts` used the old names unconditionally. Writing both old and new names is not viable because Codex validates unknown special paths and feature aliases.

## Decision

`ensureCodexConfigFile()` and `ensureCodexTrust()` now detect `codex --version` and pass it into `ensureCodexConfig()`. The config writer selects `hooks` from 0.129 onward and `:workspace_roots` from 0.131 onward, otherwise it keeps the legacy names.

## Risks

If `codex --version` is unavailable, dev3 falls back to legacy syntax because that is the most compatible choice for older installations. A new Codex install with an undetectable binary may still show warnings until the binary is available on PATH.

## Alternatives considered

Writing both key names was rejected because it causes warnings or parse failures depending on Codex version. Hard-switching to the newest syntax was rejected because it would break older Codex users.
