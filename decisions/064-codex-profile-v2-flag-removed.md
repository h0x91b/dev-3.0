# 064 — Codex `--profile-v2` flag removed: feature-detect the launch flag

## Context

Issue [#611](https://github.com/h0x91b/dev-3.0/issues/611). Decision 055 made dev-3.0 launch Codex agents with `--profile-v2 <name>` for codex ≥0.131. But `--profile-v2` existed only briefly: codex added it on 2026-05-14 (#17141) and renamed it to `--profile`/`-p` on 2026-05-21 (#23883), keeping the same file-based semantics. Newer codex rejects `--profile-v2` with `error: unexpected argument '--profile-v2' found` (exit 2), breaking every Codex launch (codex self-updates).

## Decision

Stop deciding the launch flag from a version threshold. Feature-detect it from `codex --help`:

- `pickCodexProfileLaunchFlag(helpText)` in `src/bun/codex-config.ts` returns `--profile-v2` iff the help lists `--profile-v2` (word-boundary match), else `--profile`.
- `detectCodexProfileLaunchFlag()` spawns `codex --help` and applies the picker; falls back to `--profile` on any failure (it is the safe default — `--profile-v2` is the flag that crashes).
- `applyCodexThemeProfile()` in `src/bun/agents.ts` only rewrites `-p`/`--profile` to `--profile-v2` when the detected flag is `--profile-v2`; otherwise it keeps the user's flag and just swaps the value to the themed profile. Detection is cached per process; `__setCodexProfileV2Override(true|false|null)` overrides it in tests.

The per-profile-file config writing (`profileV2` in `CodexSyntax`, gated at version ≥0.131) is unchanged — those file-based semantics still apply on both `--profile-v2` and the renamed `--profile`.

## Risks

`codex --help` is spawned once per process. If a codex build emits help without either flag, we fall back to `--profile` (keeps `-p`), which is correct for every real codex since legacy v1 also accepted `--profile`. Order matters: transition-window binaries list both flags, so `--profile-v2` is preferred when present.

## Alternatives considered

- **Version-gate `--profile-v2` to 0.131–0.133** (per issue #611's suggestion) — rejected: version numbers do not map reliably to the rename PR (alphas, forks), and the repo owner explicitly asked for feature detection.
- **Drop the profile flag entirely when help lacks it** — rejected: the `-p dev3` arg comes from agent config; removing it is more invasive and the no-flag case is unreachable for real codex.
