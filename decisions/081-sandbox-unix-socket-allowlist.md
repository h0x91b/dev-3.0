# 081 — Sandbox unix-socket allowlist for Claude Code + Codex map-form migration

## Context

Sandboxed agents (Claude Code seatbelt, Codex) block the `connect()` to the app's
Unix socket (`~/.dev3.0/sockets/<pid>.sock`). The CLI then falls back to cached reads
and falsely reports `app not running` (issue #726, the Claude Code counterpart of the
Codex fix in #100). Two gaps: (1) dev3 had no auto-config for Claude Code, and (2) dev3's
Codex auto-config still wrote the legacy `allow_unix_sockets = [...]` array, which codex
≥ 0.119 silently ignores.

## Investigation

Verified against codex source (`codex-rs/config/src/permissions_toml.rs`,
`network-proxy/src/config.rs`) at codex-cli 0.141.0: PR openai/codex#15120 replaced the
`allow_unix_sockets` array with a `[permissions.<profile>.network.unix_sockets]` map
(path → `"allow"|"deny"`). `NetworkToml` has no `serde(deny_unknown_fields)`, so the old
array key is dropped silently → allowlist empty → socket blocked. Confirmed a generated
config round-trips through `js-toml` into the expected `{ path: "allow" }` map.

## Decision

1. **Claude Code** — `applyClaudeSettings()` / `ensureClaudeSettings()` in
   `src/bun/agent-skills.ts` patch `~/.claude/settings.json` on startup, adding the dev3
   CLI permission and the sockets **directory** to `sandbox.network.allowUnixSockets`.
2. **Codex** — `src/bun/codex-config.ts` gains a `CODEX_UNIX_SOCKETS_MAP_VERSION` (0.119)
   syntax threshold; for codex ≥ 0.119 it emits the `unix_sockets` map and migrates away
   any stale `allow_unix_sockets` array (preserving its entries as `"allow"`).
3. **CLI message** — `exitAppNotRunning()` (connect stage) now says the app is likely
   running but the sandbox is blocking the socket, prints the socket path, and gives the
   fix; `socket-client.ts` treats EPERM/EACCES as a deterministic block (fail fast).

Always the sockets **directory**, never a `*.sock` glob: each entry compiles to a seatbelt
`(subpath ...)` rule (literal prefix, no `*` expansion), so the dir covers the PID-named
socket across restarts.

## Risks

- The seatbelt profile is compiled at `claude` startup, so a new `allowUnixSockets` entry
  needs a fully fresh Claude Code launch (resume/`--continue` does not rebuild it).
- Codex version detection drives the array-vs-map choice; unknown version defaults to the
  legacy array (consistent with the other version-gated syntax features).

## Alternatives considered

- `dangerously_allow_all_unix_sockets` (codex) / no allowlist — rejected, too broad.
- A `*.sock` glob in `allowUnixSockets` — rejected, seatbelt `subpath` does not expand `*`.
- Changing the CLI exit code for the connect case — rejected; the exit code is a contract,
  only the human-facing message changed.
