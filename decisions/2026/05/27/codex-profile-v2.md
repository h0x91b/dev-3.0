# Codex Profile-v2 Support

## Context

Codex PR #22647 (released in 0.131.0) rejects `--profile <name>` when the main `~/.codex/config.toml` contains either a top-level `profile = "<name>"` selector or a `[profiles.<name>]` table. Per-profile settings must now live in a separate file `~/.codex/<name>.config.toml`. Users on Codex ≥0.131 hit `Error loading config.toml: --profile dev3-light cannot be used while ~/.codex/config.toml contains legacy profile = "dev3-light" or [profiles.dev3-light]`, because dev-3.0 launches agents with `codex --profile dev3-light` / `dev3-dark` and writes those blocks into the main config.

## Investigation

The existing `getCodexSyntaxForVersion()` in `src/bun/codex-config.ts` already gates `:workspace_roots` and `hooks` behind the 0.131 / 0.129 thresholds, so the same mechanism fits the profile-v2 switch. Writing the per-profile content into separate files on older Codex versions is not safe — older Codex does not look for `~/.codex/<name>.config.toml` and would treat `--profile <name>` as undefined.

## Decision

`CodexSyntax` now carries a `profileV2: boolean` flag, set when version ≥0.131.

`ensureCodexConfig()` in `src/bun/codex-config.ts`:
- When `profileV2` is true, removes `[profiles.dev3]`, `[profiles.dev3-light]`, `[profiles.dev3-dark]` from the main config and strips any top-level `profile = "dev3"|"dev3-light"|"dev3-dark"` selector (`removeManagedTopLevelProfileSelector`).
- When `profileV2` is false, behaves exactly as before — writes `[profiles.dev3*]` blocks in-main with `web_search = "live"`.

`ensureCodexConfigFile()` additionally writes `~/.codex/dev3.config.toml`, `dev3-light.config.toml`, and `dev3-dark.config.toml` (with `web_search = "live"`) when `profileV2` is true, via the new exported `ensureCodexProfileFile()` helper. The helper upserts root-level keys and preserves any user-added content in those files.

## Risks

A user who already had a per-profile `~/.codex/dev3-light.config.toml` with `web_search` set to a different value will see it overwritten to `"live"`. This matches the previous behavior under the `[profiles.dev3-light]` block, so it is not a regression. The cleanup only strips the three managed `[profiles.dev3*]` sections — user-owned profiles like `[profiles.ro]` are untouched.

## Follow-up: launch flag (the other half)

Writing the per-profile files was only half the fix. Codex exposes **two** flags: `-p`/`--profile <name>` loads an in-config `[profiles.<name>]` block, while `--profile-v2 <name>` layers `$CODEX_HOME/<name>.config.toml` on top of the base config. dev-3.0 launched with `-p dev3-dark`, so on Codex ≥0.131 (where we no longer write the in-config block) Codex reported `config profile dev3-dark not found`.

`applyCodexThemeProfile()` in `src/bun/agents.ts` now rewrites the flag to `--profile-v2` (in addition to swapping the value to the themed profile) when `isCodexProfileV2()` is true. profile-v2 detection is cached per process and overridable in tests via `__setCodexProfileV2Override()`. Legacy Codex keeps `-p`. The base config still carries `default_permissions = "dev3"`, so the `[permissions.dev3]` sandbox/network grants apply regardless of which profile flag is used.

> **Superseded (launch flag only) — see [decision 064](./064-codex-profile-v2-flag-removed.md).** Codex later removed the `--profile-v2` flag and folded its file-based semantics into `-p`/`--profile`, so the version-gated rewrite above started crashing newer codex (issue #611). The launch flag is now feature-detected from `codex --help` instead of a version threshold. The per-profile-file config writing described above is unchanged and still correct.

## Alternatives considered

- **Always use profile-v2** — rejected: older Codex doesn't know about per-profile files, so `--profile dev3-light` would fail on legacy installs.
- **Write both legacy blocks and per-profile files** — rejected: new Codex rejects the legacy blocks, so even with the file present the legacy block in `config.toml` causes the error.
- **Stop using `--profile` and rely only on `[permissions.dev3]`** — rejected: the per-profile file controls `web_search` and any future profile-specific knobs, and the launch flow already depends on the profile selector.
