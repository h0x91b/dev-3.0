# Prune orphaned `mcp_servers.*` approvals from dev3's Codex profile files

## Context

dev3 launches Codex with a theme-selected profile (`--profile dev3-dark` / `dev3-light`), whose settings
live in `~/.codex/<profile>.config.toml` (profile-v2, codex ≥0.134). Codex persists per-tool approval
decisions into the *active profile file* as `[mcp_servers.<server>.tools.<tool>] approval_mode = "approve"`.
When that server's body later leaves the effective config, the profile file keeps a table with no
transport, and Codex refuses to load it at all — the task dies at launch with `invalid transport`
(issue #1640). Only the theme the user actually ran accumulated the block, so it looked like a
fresh-task-only regression.

## Investigation

Verified against codex-cli 0.151.0 with an isolated `CODEX_HOME`:

- `[mcp_servers.x.tools.t]` alone in the profile file → `invalid transport`, load aborts.
- Same table, but `[mcp_servers.x] command = "echo"` present in the *main* `config.toml` → loads fine.
  The main config's body rescues the profile's approval table.
- A body table with only `enabled = true` (no `command`/`url`) → still `invalid transport`.

So "has a transport" means the body carries a key other than `tools`/`enabled`, and the check must
consider the main config, not the profile file alone.

## Decision

`pruneOrphanedMcpServers()` in `src/bun/codex-config.ts` drops every `[mcp_servers.<name>.…]` table
whose server declares no transport in the profile file *and* is not defined by
`~/.codex/config.toml` (`codexServersWithTransport()`). It fails closed exactly like
`pruneCodexProjectEntries`: unparsable input, an unparsable result, or any collateral parse-level
change returns the original text — a file dev3 mangles is worse than a stale approval.

`ensureCodexProfileFile()` runs it before upserting dev3's settings, and the loop over the managed
profiles moved into an exported `ensureCodexProfileFiles(homePath)` so `ensureCodexTrust()`
(`src/bun/agents.ts`) can repair the files before *every* Codex spawn. Startup-only repair would not
be enough: the orphan appears mid-session, after the app has already patched the file.

## Risks

An MCP server declared through a key we do not recognize as a transport would be pruned along with its
approvals. Mitigated by treating *any* key except `tools`/`enabled` as a transport, so only genuinely
body-less entries are targets, and by the fail-closed re-parse comparison.

## Alternatives considered

Rewriting the profile file from scratch on every launch (loses user edits and Codex's own state);
never letting Codex persist approvals into a dev3 profile (not something dev3 controls); leaving the
main `config.toml` orphans alone was deliberate — that file is the user's, and dev3 does not write
`mcp_servers` there.
