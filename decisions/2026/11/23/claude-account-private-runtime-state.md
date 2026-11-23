# Claude accounts keep per-login runtime state private

## Context

Managed Claude account dirs symlink every entry of `~/.claude` except a deny-list (see
`decisions/2026/07/29/claude-config-dir-share-by-default.md`). The list covered the login,
identity, usage and org policy, but Claude Code keeps writing more per-login files into its
config dir, and all of them were shared across accounts.

## Investigation

Identity backups (`.claude.json.backup.*`, with `userID` and `oauthAccount`) could restore one
account's identity into another. Queued telemetry carries account and org uuids. The background
daemon's `control.key`, locks and status files collide when two logins share one directory.
Managed settings (`remote-settings.json*`, `policy-limits.json*`) and the MCP auth caches are
fetched and issued per login.

## Decision

`CLAUDE_PRIVATE_ENTRIES` in `src/bun/agent-accounts.ts` gains `backups`, `telemetry`, `state`,
`.config.json`, `hfi-auth.json`, the MCP auth/discovery caches, `remote-control` and `ccr`.
A prefix list adds `daemon*`, `policy-limits.json*` and `remote-settings.json*`.
`scaffoldClaudeAccountDir` removes an existing symlink to such an entry only when it points exactly
at `~/.claude/<entry>`, the link scaffolding made; real files, links elsewhere and `~/.claude` itself are never touched. Transcripts,
memory and history stay shared: the same projects run under different accounts and resume crosses
accounts. The per-install analytics ids `userID` and `machineID` are no longer copied into a new
account's `.claude.json` (seeding and import both drop them; import keeps `oauthAccount`), so Claude
Code generates fresh ones and the account reports its own user and device.

## Risks

A newly private entry starts empty per account and is recreated by Claude Code on demand. A future
per-login file is shared until it is added to the list; the credential-shaped patterns remain the
safety net. A prefix such as `daemon` also hides an unrelated future entry that happens to start
with it. Existing accounts keep the ids they already copied: user state is not rewritten
automatically, and a one-off local cleanup is the user's call.

## Alternatives considered

An allow-list of shared entries: rejected for the reason in the share-by-default record, it
silently loses every new resource type Claude Code adds.
