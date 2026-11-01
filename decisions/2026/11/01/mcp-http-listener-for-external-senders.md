# MCP over HTTP on a loopback listener, for agents outside dev3

## Context

External senders (`decisions/2026/10/26/external-senders.md`) reach dev3 only through the same-user CLI socket, so an agent on another machine needs ssh plus a forced-command wrapper (h0x91b/dev-3.0#2066). `cli-tool-architecture` and `agent-vent-feedback` rejected an HTTP server and MCP for agents INSIDE worktrees; those keep the CLI. This record covers clients outside dev3 only.

## Investigation

The remote-access server binds `0.0.0.0` and its tunnel forwards it whole, and its JWT has no scope, so neither can carry this. dev3's Codex sandbox profile can write all of `~/.dev3.0`, so a token store there could be enrolled into by a task. `message.sendAsSender` types into a live agent with no dialog, and the all-agent `stats.usage` scan runs on the app's main thread and ignores any `since`.

## Decision

`src/bun/mcp/`: stateless MCP over HTTP (JSON responses only) on its own `127.0.0.1:7391` listener, off until `dev3 mcp enable`, never in a guest instance; remote clients come through `tailscale serve --tcp` or `ssh -L`. Per-sender bearer tokens with scopes (`read` default; `stats`, `send`, `write`, `start`, `content`), a required project allow-list and a 90-day expiry live as hashes in `~/.config/dev3/mcp.json` (`%APPDATA%\dev3`), written only by `src/cli/commands/mcp.ts`. `tools.ts` is a fixed table over existing socket handlers in CLI `--json` terms; senders act only through `*AsSender`, and launches and resumes never auto-approve unless the token was issued with `--auto-approve` (the origin travels out of band in the handler context, `McpRequestOrigin`, never as a socket param).

## Risks

A `send` or `start` token lets a tailnet peer drive an agent with a shell — mitigated by `read`-only defaults, the allow-list, expiry, revocation and a per-call audit line, not eliminated; tokens do not fix the socket's "attribution, not authentication". The audit trail is the 14-day diagnostic log, which Codex tasks can write, and `external-senders.json` (whose label the dialog shows, and whose deletion revokes a sender's tokens) is writable there too. A local process that holds the port before the app binds receives clients' bearer tokens; `dev3 mcp status` shows the bind error. The inbox is per sender, so a token reads replies from every project that sender messaged. Open questions for the maintainer, taken at the spec's defaults: MCP vs a plain JSON API on the same listener; own listener vs a remote-server route; store outside `~/.dev3.0` vs under it with an in-app confirm per token; no network auto-approve by default; exit 25 for MCP launches (and whether the CLI's sender move should match); whether the `content` scope should exist at all.

## Alternatives considered

A plain JSON API (only `server.ts` would change); `/mcp` on the remote server (tunnel exposure, `0.0.0.0`); reusing the remote JWT (no scope, no per-token revocation); stdio over ssh (a process per call, an OS account per host); SSE or MCP "tasks" for long calls (bounded calls plus "pending, call again" lose nothing on a dropped stream); `@modelcontextprotocol/sdk` (four methods used).
