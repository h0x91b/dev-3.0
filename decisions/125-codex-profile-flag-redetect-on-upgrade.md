# 125 — Re-detect the Codex profile flag when codex is upgraded mid-session

## Context

Decision [064](./064-codex-profile-v2-flag-removed.md) (issue [#611](https://github.com/h0x91b/dev-3.0/issues/611)) fixed the `--profile-v2` → `--profile` rename by feature-detecting the launch flag from `codex --help` — but cached the result for the **whole dev3 process lifetime**. Codex self-updates (and users upgrade it) while dev3 keeps running. When an upgrade crosses the rename boundary, the cached flag goes stale: dev3 keeps launching every new Codex pane with `--profile-v2`, which the new binary rejects (`error: unexpected argument '--profile-v2' found`, exit 2). The failure looks like a broken integration but is fixed only by restarting dev3. Observed live with codex `0.144.1` (which dropped `--profile-v2`).

## Investigation

`getCodexProfileLaunchFlag()` in `src/bun/agents.ts` memoized `detectCodexProfileLaunchFlag()` once and never invalidated it. #611's own scenario re-fires on any future codex flag change. Two installs at different versions (`~/.bun/bin/codex` vs an fnm/npm copy) make it worse: detection can probe one binary while the launch resolves another.

## Decision

Re-detect the flag whenever the installed codex **version** changes, in `src/bun/agents.ts`:

- New pure helper `resolveProfileFlagForVersion(currentVersion, cached, detect)` returns the cached `{ flag, version }` while `currentVersion` is unchanged, else calls `detect()` and re-keys — so the cache-invalidation logic is unit-tested without spawning.
- `getCodexProfileLaunchFlag()` now reads `detectCodexVersion()` on each call and passes it through the helper. The `codex --version` probe is cheap and runs only on a user-initiated launch; the pricier `codex --help` parse re-runs only when the version actually changed. The test override (`__setCodexProfileV2Override`) still short-circuits before any probe.

## Risks

Adds one `codex --version` child spawn per Codex launch. Launches are user-initiated and infrequent, so the cost is imperceptible; this is deliberately narrower than caching-once. Scope is limited to the launch flag (pure command-arg construction, no on-disk effects). **Follow-up:** `getCodexVersionCached()` — used for config-syntax gating in `ensureCodexTrust` — is still cached for the process lifetime, so a mid-session upgrade could still mis-gate `~/.codex/config.toml` syntax. Left untouched here because that path writes to the shared `~/.codex` config (higher blast radius); worth the same version-keying later.

## Alternatives considered

- **TTL-based cache invalidation** — rejected: only eventually-correct, time-based (harder to test deterministically), and no better than version-keying for the actual failure.
- **Spawn `codex --help` on every launch (no cache)** — rejected: re-parses help needlessly when nothing changed; version-keying keeps the `--help` parse on the change edge only.
- **Reset the cache on a dev3 lifecycle event** — rejected: external codex upgrades emit no signal dev3 can hook.
